const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const catalogIdentityService = require('../catalog/catalog-identity.service');
const { PRODUCT_ROLES } = require('../product/product.constants');
const { validateArticleMarkdown } = require('./article-markdown.validator');

// Editorial workflow.
//
//   DRAFT -> FACT_CHECK -> RIGHTS_REVIEW -> SCHEDULED -> PUBLISHED
//   PUBLISHED -> CORRECTED | RETRACTED
//
// CONCURRENCY. Every mutation runs inside one transaction that begins by taking a
// row lock on the article (SELECT ... FOR UPDATE), then re-reads the status, the
// current revision and the assets, then re-checks the actor's role. The previous
// revision read all of that outside the transaction and later updated by id, so:
//
//   * request A could read SCHEDULED, request B could publish, and A could then
//     edit the now-PUBLISHED article with no correction status, no correctedAt and
//     no changeNote; and
//   * a publish could pass its hero-rights check while another transaction added an
//     unresolved hero asset, and then publish on the strength of the stale check.
//
// Holding the lock for the whole unit of work removes both windows. A caller may
// also pass expectedRevisionNumber for an explicit CAS, which turns a lost race
// into a stable 409 instead of a surprise.
//
// PUBLICATION CONTRACT. A DRAFT may have a null body. A publicly readable article
// may not: publishing requires a non-empty body, and every CORRECTED revision
// requires a non-empty changeNote and an actual content change. The body is
// re-validated against the Markdown AST at publish time, so a body stored before a
// rule tightened cannot slip out through a later publish.

const ALLOWED_TRANSITIONS = Object.freeze({
  DRAFT: ['FACT_CHECK'],
  FACT_CHECK: ['DRAFT', 'RIGHTS_REVIEW'],
  RIGHTS_REVIEW: ['FACT_CHECK', 'SCHEDULED'],
  SCHEDULED: ['RIGHTS_REVIEW', 'PUBLISHED'],
  PUBLISHED: ['CORRECTED', 'RETRACTED'],
  CORRECTED: ['CORRECTED', 'RETRACTED'],
  RETRACTED: []
});

const PUBLICLY_READABLE_STATUSES = Object.freeze(['PUBLISHED', 'CORRECTED']);
const CLEARED_RIGHTS_STATUSES = Object.freeze(['PROVIDER_LICENSED', 'OFFICIAL_PRESS_KIT', 'CLEARED']);

const ARTICLE_SELECT = {
  id: true,
  slug: true,
  status: true,
  locale: true,
  headline: true,
  excerpt: true,
  authorUserId: true,
  currentRevisionId: true,
  scheduledFor: true,
  publishedAt: true,
  correctedAt: true,
  retractedAt: true,
  aiDraftUsed: true,
  createdAt: true,
  updatedAt: true,
  // The published body lives on the revision, so the article DTO has to read it.
  // Previously bodyMarkdown was written and never selected, which made the public
  // magazine endpoint return an article with no article in it.
  currentRevision: {
    select: {
      id: true,
      revisionNumber: true,
      status: true,
      bodyMarkdown: true,
      changeNote: true,
      aiDraft: true,
      createdAt: true
    }
  },
  sources: {
    select: {
      sourceType: true,
      publisherKey: true,
      headline: true,
      excerpt: true,
      sourceUrl: true,
      publishedAt: true,
      fetchedAt: true,
      contentHash: true,
      provenance: true
    },
    orderBy: [{ publishedAt: 'desc' }, { contentHash: 'asc' }]
  },
  gameLinks: {
    select: { catalogGameId: true, relation: true },
    orderBy: [{ catalogGameId: 'asc' }]
  },
  assets: {
    select: { kind: true, url: true, rightsStatus: true, attribution: true, isHero: true },
    orderBy: [{ isHero: 'desc' }, { url: 'asc' }]
  }
};

function isUniqueViolation(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/// Markdown rendering policy for the public body.
///
/// The stored body is CommonMark *without* embedded HTML. Raw HTML and script are
/// rejected at the validator boundary, and the contract tells the client to render
/// with an HTML-disabled CommonMark renderer, so a body can never introduce markup
/// or a remote resource of its own. Images must come from the rights-reviewed
/// article assets, not from inline Markdown.
const BODY_FORMAT = 'commonmark-no-html';

function heroImageOf(article) {
  const heroAsset = (article.assets ?? []).find((asset) => asset.isHero) ?? null;

  if (!heroAsset) {
    return { heroImage: null, withheldReason: null };
  }

  return CLEARED_RIGHTS_STATUSES.includes(heroAsset.rightsStatus)
    ? {
      heroImage: {
        url: heroAsset.url,
        rightsStatus: heroAsset.rightsStatus,
        attribution: heroAsset.attribution ?? null
      },
      withheldReason: null
    }
    // An unresolved or restricted rights status is reported, never rendered.
    : { heroImage: null, withheldReason: 'rights_status_unresolved' };
}

function mapSources(article) {
  return (article.sources ?? []).map((source) => ({
    sourceType: source.sourceType,
    publisherKey: source.publisherKey,
    headline: source.headline,
    excerpt: source.excerpt ?? null,
    sourceUrl: source.sourceUrl,
    publishedAt: source.publishedAt ? source.publishedAt.toISOString() : null,
    fetchedAt: source.fetchedAt.toISOString(),
    contentHash: source.contentHash,
    provenance: source.provenance
  }));
}

function mapRelatedGames(article) {
  return (article.gameLinks ?? []).map((link) => ({
    catalogGameId: link.catalogGameId,
    relation: link.relation
  }));
}

/// Public article. Only reachable for PUBLISHED or CORRECTED, and every field the
/// contract promises is non-null here, so a client never has to model an optional
/// body or an optional revision.
///
/// Throws rather than emitting a degraded shape: a publicly readable article with no
/// body is a data defect, and serving `bodyMarkdown: null` would push that defect
/// into every client instead of surfacing it here.
function mapPublicArticle(article) {
  if (!PUBLICLY_READABLE_STATUSES.includes(article.status)) {
    throw new AppError(404, 'ARTICLE_NOT_FOUND', 'Article could not be found');
  }

  const revision = article.currentRevision ?? null;
  const body = typeof revision?.bodyMarkdown === 'string' ? revision.bodyMarkdown.trim() : '';

  if (!revision || body.length === 0) {
    throw new AppError(500, 'ARTICLE_PUBLIC_BODY_MISSING',
      'A published article must have a current revision with a non-empty body');
  }

  const changeNote = typeof revision.changeNote === 'string' ? revision.changeNote.trim() : '';

  if (article.status === 'CORRECTED' && changeNote.length === 0) {
    throw new AppError(500, 'ARTICLE_PUBLIC_CORRECTION_NOTE_MISSING',
      'A corrected article must carry a non-empty change note');
  }

  const { heroImage, withheldReason } = heroImageOf(article);

  return {
    slug: article.slug,
    status: article.status,
    locale: article.locale,
    headline: article.headline,
    excerpt: article.excerpt,
    bodyFormat: BODY_FORMAT,
    bodyMarkdown: revision.bodyMarkdown,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    correctedAt: article.correctedAt ? article.correctedAt.toISOString() : null,
    revision: {
      revisionNumber: revision.revisionNumber,
      status: revision.status,
      changeNote: article.status === 'CORRECTED' ? revision.changeNote : (revision.changeNote ?? null),
      createdAt: revision.createdAt.toISOString()
    },
    heroImage,
    heroImageWithheldReason: withheldReason,
    sources: mapSources(article),
    relatedGames: mapRelatedGames(article)
  };
}

/// Editor article. A draft body may legitimately be null here, and internal
/// workflow metadata is included.
function mapEditorArticle(article) {
  const revision = article.currentRevision ?? null;
  const { heroImage, withheldReason } = heroImageOf(article);

  return {
    id: article.id,
    slug: article.slug,
    status: article.status,
    locale: article.locale,
    headline: article.headline,
    excerpt: article.excerpt,
    bodyFormat: BODY_FORMAT,
    bodyMarkdown: revision?.bodyMarkdown ?? null,
    revision: revision
      ? {
        revisionNumber: revision.revisionNumber,
        status: revision.status,
        changeNote: revision.changeNote ?? null,
        aiDraft: revision.aiDraft,
        createdAt: revision.createdAt.toISOString()
      }
      : null,
    authorUserId: article.authorUserId,
    scheduledFor: article.scheduledFor ? article.scheduledFor.toISOString() : null,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    correctedAt: article.correctedAt ? article.correctedAt.toISOString() : null,
    retractedAt: article.retractedAt ? article.retractedAt.toISOString() : null,
    aiDraftUsed: article.aiDraftUsed,
    heroImage,
    heroImageWithheldReason: withheldReason,
    sources: mapSources(article),
    relatedGames: mapRelatedGames(article),
    createdAt: article.createdAt.toISOString(),
    updatedAt: article.updatedAt.toISOString()
  };
}

/// Card-sized summary for the Today feed. Deliberately carries no body: a Today
/// response can hold several articles, and shipping multiple 40 KB bodies to a
/// mobile client for cards it may never open is a waste of the user's data.
function mapArticleSummary(article) {
  const { heroImage, withheldReason } = heroImageOf(article);

  return {
    slug: article.slug,
    status: article.status,
    locale: article.locale,
    headline: article.headline,
    excerpt: article.excerpt,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    correctedAt: article.correctedAt ? article.correctedAt.toISOString() : null,
    heroImage,
    heroImageWithheldReason: withheldReason,
    relatedGames: mapRelatedGames(article),
    sourceCount: (article.sources ?? []).length
  };
}

function assertTransitionAllowed(fromStatus, toStatus) {
  if (!ALLOWED_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new AppError(409, 'ARTICLE_TRANSITION_NOT_ALLOWED',
      `An article cannot move from ${fromStatus} to ${toStatus}`);
  }
}

/// Appends a revision and makes it the article's current revision, atomically.
///
/// `bodyMarkdown: undefined` means "unchanged", so the previous body is carried
/// forward. Only an explicit null clears it. Before this existed, any update that
/// omitted the body wrote a revision with bodyMarkdown null and silently discarded
/// the article text.
async function appendRevision({
  tx,
  articleId,
  status,
  headline,
  excerpt,
  bodyMarkdown,
  changeNote,
  aiDraft = false,
  editorUserId
}) {
  const previous = await tx.articleRevision.findFirst({
    where: { articleId },
    select: { revisionNumber: true, headline: true, excerpt: true, bodyMarkdown: true },
    orderBy: { revisionNumber: 'desc' }
  });

  const resolvedChangeNote = typeof changeNote === 'string' && changeNote.trim().length > 0
    ? changeNote.trim()
    : null;

  // Enforced at the single write point, so no caller can create a CORRECTED
  // revision without an audit note.
  if (status === 'CORRECTED' && resolvedChangeNote === null) {
    throw new AppError(409, 'ARTICLE_CORRECTION_NOTE_REQUIRED',
      'A correction revision requires a non-empty changeNote', [{
        field: 'changeNote',
        message: 'required'
      }]);
  }

  const revision = await tx.articleRevision.create({
    data: {
      articleId,
      revisionNumber: (previous?.revisionNumber ?? 0) + 1,
      status,
      headline: headline ?? previous?.headline ?? '',
      excerpt: excerpt ?? previous?.excerpt ?? '',
      bodyMarkdown: bodyMarkdown === undefined ? (previous?.bodyMarkdown ?? null) : bodyMarkdown,
      changeNote: resolvedChangeNote,
      aiDraft,
      editorUserId
    },
    select: { id: true, revisionNumber: true }
  });

  await tx.editorialArticle.update({
    where: { id: articleId },
    data: { currentRevisionId: revision.id },
    select: { id: true }
  });

  return revision;
}

/// Upserts the sources, related games and assets carried by a create or update.
///
/// Runs inside the caller's transaction, so an article never ends up with half its
/// relations. Every asset arrives with an explicit rightsStatus, which is what the
/// publish-time hero check reads.
async function attachRelations({ tx, articleId, input, now }) {
  for (const source of input.sources ?? []) {
    await tx.articleSource.upsert({
      where: { articleId_contentHash: { articleId, contentHash: source.contentHash } },
      create: {
        articleId,
        sourceType: source.sourceType,
        publisherKey: source.publisherKey,
        headline: source.headline,
        excerpt: source.excerpt ?? null,
        sourceUrl: source.sourceUrl,
        publishedAt: source.publishedAt ? new Date(source.publishedAt) : null,
        fetchedAt: source.fetchedAt ? new Date(source.fetchedAt) : now,
        contentHash: source.contentHash
      },
      update: {
        headline: source.headline,
        excerpt: source.excerpt ?? null
      },
      select: { id: true }
    });
  }

  for (const link of input.relatedGames ?? []) {
    const canonicalId = await catalogIdentityService.resolveCanonicalGameId(link.catalogGameId, { client: tx });

    if (!canonicalId) {
      throw new AppError(400, 'CATALOG_GAME_NOT_FOUND', 'A related catalog game could not be found');
    }

    await tx.articleGameLink.upsert({
      where: { articleId_catalogGameId: { articleId, catalogGameId: canonicalId } },
      create: { articleId, catalogGameId: canonicalId, relation: link.relation },
      update: { relation: link.relation },
      select: { id: true }
    });
  }

  for (const asset of input.assets ?? []) {
    await tx.articleAsset.upsert({
      where: { articleId_url: { articleId, url: asset.url } },
      create: {
        articleId,
        kind: asset.kind,
        url: asset.url,
        rightsStatus: asset.rightsStatus,
        attribution: asset.attribution ?? null,
        isHero: asset.isHero === true
      },
      update: {
        kind: asset.kind,
        rightsStatus: asset.rightsStatus,
        attribution: asset.attribution ?? null,
        isHero: asset.isHero === true
      },
      select: { id: true }
    });
  }
}

/// Locks the article row for the duration of the transaction and returns it with
/// everything a transition decision needs. Anything read after this call is a
/// consistent snapshot that no concurrent writer can move underneath us.
async function lockArticleForUpdate({ tx, slug }) {
  const locked = await tx.$queryRaw`
    SELECT "id" FROM "editorial_articles" WHERE "slug" = ${slug} FOR UPDATE
  `;

  if (!Array.isArray(locked) || locked.length === 0) {
    throw new AppError(404, 'ARTICLE_NOT_FOUND', 'Article could not be found');
  }

  return tx.editorialArticle.findUnique({ where: { id: locked[0].id }, select: ARTICLE_SELECT });
}

/// Optional optimistic concurrency check on top of the row lock. A caller that
/// supplies the revision it based its edit on gets a stable 409 rather than
/// silently overwriting someone else's committed change.
function assertExpectedRevision({ article, expectedRevisionNumber }) {
  if (expectedRevisionNumber === undefined || expectedRevisionNumber === null) {
    return;
  }

  const current = article.currentRevision?.revisionNumber ?? null;

  if (current !== expectedRevisionNumber) {
    throw new AppError(409, 'ARTICLE_CONCURRENT_MODIFICATION',
      'The article changed since it was read; re-read it and retry', [{
        field: 'expectedRevisionNumber',
        message: String(current)
      }]);
  }
}

/// Re-checks the actor's role inside the transaction, so a revocation that commits
/// mid-request cannot be outrun by a publish already in flight.
const EDITORIAL_ROLES = Object.freeze([PRODUCT_ROLES.EDITOR, PRODUCT_ROLES.ADMIN]);

async function assertEditorRoleInTransaction({ tx, actorUserId, action }) {
  const assignments = await tx.userRoleAssignment.findMany({
    where: { userId: actorUserId, revokedAt: null, role: { in: [...EDITORIAL_ROLES] } },
    select: { role: true }
  });

  if (assignments.length === 0) {
    throw new AppError(403, 'FORBIDDEN_ROLE', `${action} requires a current EDITOR or ADMIN role`);
  }
}

function assertPublishableBody(bodyMarkdown) {
  const body = typeof bodyMarkdown === 'string' ? bodyMarkdown.trim() : '';

  if (body.length === 0) {
    throw new AppError(409, 'ARTICLE_BODY_REQUIRED_FOR_PUBLICATION',
      'A publicly readable article requires a non-empty body');
  }

  // Re-validate at publish time: a body stored before a rule tightened must not
  // reach readers through a later publish.
  const { valid, violations } = validateArticleMarkdown(body);

  if (!valid) {
    throw new AppError(409, 'ARTICLE_MARKDOWN_RESOURCE_NOT_ALLOWED',
      'The current body contains a resource that is not allowed in a published article',
      violations.map((violation) => ({ field: 'bodyMarkdown', message: violation.reasonCode })));
  }

  return body;
}

/// Refuses to publish while any hero asset still lacks resolved rights. Read inside
/// the transaction that holds the article lock, so the result cannot be stale.
function assertHeroRightsResolved(assets) {
  const heroAssets = (assets ?? []).filter((asset) => asset.isHero);
  const unresolved = heroAssets.find((asset) => !CLEARED_RIGHTS_STATUSES.includes(asset.rightsStatus));

  if (unresolved) {
    throw new AppError(409, 'ARTICLE_HERO_RIGHTS_UNRESOLVED',
      'An image with an unresolved rights status cannot be published as the public hero image');
  }

  return heroAssets.length;
}

async function getPublishedArticleBySlug({ slug }) {
  const article = await prisma.editorialArticle.findFirst({
    where: { slug, status: { in: [...PUBLICLY_READABLE_STATUSES] } },
    select: ARTICLE_SELECT
  });

  if (!article) {
    throw new AppError(404, 'ARTICLE_NOT_FOUND', 'Article could not be found');
  }

  return mapPublicArticle(article);
}

async function createArticle({ actorUserId, input, now = new Date() }) {
  // An AI-assisted draft may only ever be created as DRAFT.
  const status = 'DRAFT';

  try {
    const article = await prisma.$transaction(async (tx) => {
      await assertEditorRoleInTransaction({ tx, actorUserId, action: 'Creating an article' });

      const created = await tx.editorialArticle.create({
        data: {
          slug: input.slug,
          status,
          locale: input.locale,
          headline: input.headline,
          excerpt: input.excerpt,
          authorUserId: actorUserId,
          aiDraftUsed: input.aiDraftUsed === true
        },
        select: { id: true }
      });

      await appendRevision({
        tx,
        articleId: created.id,
        status,
        headline: input.headline,
        excerpt: input.excerpt,
        bodyMarkdown: input.bodyMarkdown ?? null,
        changeNote: 'initial draft',
        aiDraft: input.aiDraftUsed === true,
        editorUserId: actorUserId
      });

      await attachRelations({ tx, articleId: created.id, input, now });

      return tx.editorialArticle.findUnique({ where: { id: created.id }, select: ARTICLE_SELECT });
    });

    logger.info('editorial-article-created', {
      status,
      aiDraftUsed: input.aiDraftUsed === true,
      sourceCount: (input.sources ?? []).length,
      relatedGameCount: (input.relatedGames ?? []).length
    });

    return mapEditorArticle(article);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'ARTICLE_SLUG_TAKEN', 'An article with this slug already exists');
    }

    throw error;
  }
}

/// Fields whose change is visible to a reader. Touching any of them on an already
/// public article is a correction, not an edit.
function describesPublicChange(input) {
  return input.headline !== undefined
    || input.excerpt !== undefined
    || input.locale !== undefined
    || input.bodyMarkdown !== undefined
    || (input.assets ?? []).length > 0
    || (input.sources ?? []).length > 0
    || (input.relatedGames ?? []).length > 0;
}

async function updateArticle({ actorUserId, slug, input, now = new Date() }) {
  const article = await prisma.$transaction(async (tx) => {
    const existing = await lockArticleForUpdate({ tx, slug });

    await assertEditorRoleInTransaction({ tx, actorUserId, action: 'Editing an article' });
    assertExpectedRevision({ article: existing, expectedRevisionNumber: input.expectedRevisionNumber });

    if (existing.status === 'RETRACTED') {
      throw new AppError(409, 'ARTICLE_RETRACTED', 'A retracted article can no longer be edited');
    }

    // Status is re-read under the lock, so a publish that committed while this
    // request was waiting is visible here and forces the correction path.
    const alreadyPublic = PUBLICLY_READABLE_STATUSES.includes(existing.status);
    const changesPublicContent = alreadyPublic && describesPublicChange(input);

    if (input.status && input.status !== existing.status) {
      assertTransitionAllowed(existing.status, input.status);
    }

    if (changesPublicContent) {
      if (input.status !== 'CORRECTED') {
        throw new AppError(409, 'ARTICLE_CORRECTION_REQUIRED',
          'Changing published content requires status CORRECTED', [{
            field: 'status',
            message: 'CORRECTED'
          }]);
      }

      if (typeof input.changeNote !== 'string' || input.changeNote.trim().length === 0) {
        throw new AppError(409, 'ARTICLE_CORRECTION_NOTE_REQUIRED',
          'A correction requires a non-empty changeNote', [{
            field: 'changeNote',
            message: 'required'
          }]);
      }
    }

    // A status-only hop to CORRECTED records an audit entry for a change nobody
    // made, which is worse than no entry at all.
    if (input.status === 'CORRECTED' && !changesPublicContent) {
      throw new AppError(409, 'ARTICLE_CORRECTION_EMPTY',
        'A correction must change something a reader can see', [{
          field: 'status',
          message: 'no_public_change'
        }]);
    }

    const becomesCorrection = input.status === 'CORRECTED';
    const nextStatus = input.status ?? existing.status;
    const previousBody = existing.currentRevision?.bodyMarkdown ?? null;
    const nextBody = input.bodyMarkdown === undefined ? previousBody : input.bodyMarkdown;

    // A publicly readable article must still have a body after the edit.
    if (PUBLICLY_READABLE_STATUSES.includes(nextStatus)) {
      assertPublishableBody(nextBody);
    }

    await tx.editorialArticle.update({
      where: { id: existing.id },
      data: {
        ...(input.headline ? { headline: input.headline } : {}),
        ...(input.excerpt ? { excerpt: input.excerpt } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.scheduledFor !== undefined
          ? { scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null }
          : {}),
        ...(input.status ? { status: input.status } : {}),
        // A correction is timestamped, so a reader and a reviewer can both see that
        // the live article changed and when.
        ...(becomesCorrection ? { correctedAt: now } : {})
      },
      select: { id: true }
    });

    await appendRevision({
      tx,
      articleId: existing.id,
      status: nextStatus,
      headline: input.headline ?? existing.headline,
      excerpt: input.excerpt ?? existing.excerpt,
      // undefined carries the previous body forward; explicit null clears it.
      bodyMarkdown: input.bodyMarkdown,
      changeNote: input.changeNote ?? null,
      aiDraft: input.aiDraftUsed === true,
      editorUserId: actorUserId
    });

    await attachRelations({ tx, articleId: existing.id, input, now });

    return tx.editorialArticle.findUnique({ where: { id: existing.id }, select: ARTICLE_SELECT });
  });

  logger.info('editorial-article-updated', {
    toStatus: article.status,
    sourceCount: (input.sources ?? []).length,
    correctionRecorded: article.status === 'CORRECTED',
    roleCheckedInTransaction: true
  });

  return mapEditorArticle(article);
}

async function publishArticle({ actorUserId, slug, expectedRevisionNumber = null, now = new Date() }) {
  const published = await prisma.$transaction(async (tx) => {
    const article = await lockArticleForUpdate({ tx, slug });

    // Role, transition, body and hero rights are all decided inside the lock, so
    // none of them can be a stale read.
    await assertEditorRoleInTransaction({ tx, actorUserId, action: 'Publishing' });
    assertExpectedRevision({ article, expectedRevisionNumber });
    assertTransitionAllowed(article.status, 'PUBLISHED');

    const heroAssetCount = assertHeroRightsResolved(article.assets);

    assertPublishableBody(article.currentRevision?.bodyMarkdown ?? null);

    await tx.editorialArticle.update({
      where: { id: article.id },
      data: { status: 'PUBLISHED', publishedAt: now },
      select: { id: true }
    });

    // bodyMarkdown omitted, so appendRevision carries the reviewed body forward.
    await appendRevision({
      tx,
      articleId: article.id,
      status: 'PUBLISHED',
      changeNote: 'published',
      editorUserId: actorUserId
    });

    logger.info('editorial-article-published', {
      heroAssetCount,
      aiDraftUsed: article.aiDraftUsed,
      roleCheckedInTransaction: true
    });

    return tx.editorialArticle.findUnique({ where: { id: article.id }, select: ARTICLE_SELECT });
  });

  return mapEditorArticle(published);
}

async function retractArticle({ actorUserId, slug, reasonCode, expectedRevisionNumber = null, now = new Date() }) {
  const retracted = await prisma.$transaction(async (tx) => {
    const article = await lockArticleForUpdate({ tx, slug });

    await assertEditorRoleInTransaction({ tx, actorUserId, action: 'Retracting' });
    assertExpectedRevision({ article, expectedRevisionNumber });
    assertTransitionAllowed(article.status, 'RETRACTED');

    await tx.editorialArticle.update({
      where: { id: article.id },
      data: { status: 'RETRACTED', retractedAt: now },
      select: { id: true }
    });

    await appendRevision({
      tx,
      articleId: article.id,
      status: 'RETRACTED',
      changeNote: `retracted:${reasonCode}`,
      editorUserId: actorUserId
    });

    return tx.editorialArticle.findUnique({ where: { id: article.id }, select: ARTICLE_SELECT });
  });

  logger.info('editorial-article-retracted', { reasonCode, roleCheckedInTransaction: true });

  return mapEditorArticle(retracted);
}

async function listArticlesForEditor({ status = null, locale = null, limit = 20 }) {
  const articles = await prisma.editorialArticle.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(locale ? { locale } : {})
    },
    select: ARTICLE_SELECT,
    // Deterministic: newest updates first, slug breaks ties.
    orderBy: [{ updatedAt: 'desc' }, { slug: 'asc' }],
    take: limit
  });

  return { articles: articles.map(mapEditorArticle) };
}

/// Curated slice for the Today feed: published (or corrected) articles only,
/// newest first with a deterministic slug tie-break.
async function listPublishedArticles({ locale = null, limit = 5, now = new Date() }) {
  const articles = await prisma.editorialArticle.findMany({
    where: {
      status: { in: [...PUBLICLY_READABLE_STATUSES] },
      publishedAt: { not: null, lte: now },
      ...(locale ? { locale } : {})
    },
    select: ARTICLE_SELECT,
    orderBy: [{ publishedAt: 'desc' }, { slug: 'asc' }],
    take: limit
  });

  // Summaries only: the Today feed must not carry full bodies.
  return articles.map(mapArticleSummary);
}

module.exports = {
  ALLOWED_TRANSITIONS,
  BODY_FORMAT,
  CLEARED_RIGHTS_STATUSES,
  PUBLICLY_READABLE_STATUSES,
  assertHeroRightsResolved,
  assertPublishableBody,
  assertTransitionAllowed,
  createArticle,
  describesPublicChange,
  getPublishedArticleBySlug,
  listArticlesForEditor,
  listPublishedArticles,
  mapArticleSummary,
  mapEditorArticle,
  mapPublicArticle,
  publishArticle,
  retractArticle,
  updateArticle
};
