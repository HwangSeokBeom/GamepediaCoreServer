const { Prisma } = require('@prisma/client');
const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { logger } = require('../../utils/logger');
const userRoleService = require('../product/user-role.service');
const catalogIdentityService = require('../catalog/catalog-identity.service');

// Editorial workflow.
//
//   DRAFT -> FACT_CHECK -> RIGHTS_REVIEW -> SCHEDULED -> PUBLISHED
//   PUBLISHED -> CORRECTED | RETRACTED
//
// Rules enforced here:
//   * transitions follow the graph; anything else is rejected,
//   * an AI-assisted draft may only ever sit in DRAFT,
//   * publishing re-checks the actor's EDITOR/ADMIN role in the database,
//   * an article whose hero image has an unresolved rights status cannot publish,
//   * source rows keep a headline, short excerpt, URL, timestamps and a hash.

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
  scheduledFor: true,
  publishedAt: true,
  correctedAt: true,
  retractedAt: true,
  aiDraftUsed: true,
  createdAt: true,
  updatedAt: true,
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

function mapArticle(article, { includeInternal = false } = {}) {
  const heroAsset = (article.assets ?? []).find((asset) => asset.isHero) ?? null;

  return {
    slug: article.slug,
    status: article.status,
    locale: article.locale,
    headline: article.headline,
    excerpt: article.excerpt,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
    correctedAt: article.correctedAt ? article.correctedAt.toISOString() : null,
    retractedAt: article.retractedAt ? article.retractedAt.toISOString() : null,
    heroImage: heroAsset && CLEARED_RIGHTS_STATUSES.includes(heroAsset.rightsStatus)
      ? { url: heroAsset.url, rightsStatus: heroAsset.rightsStatus, attribution: heroAsset.attribution ?? null }
      // An unresolved or restricted rights status is reported, never rendered.
      : null,
    heroImageWithheldReason: heroAsset && !CLEARED_RIGHTS_STATUSES.includes(heroAsset.rightsStatus)
      ? 'rights_status_unresolved'
      : null,
    sources: (article.sources ?? []).map((source) => ({
      sourceType: source.sourceType,
      publisherKey: source.publisherKey,
      headline: source.headline,
      excerpt: source.excerpt ?? null,
      sourceUrl: source.sourceUrl,
      publishedAt: source.publishedAt ? source.publishedAt.toISOString() : null,
      fetchedAt: source.fetchedAt.toISOString(),
      contentHash: source.contentHash,
      provenance: source.provenance
    })),
    relatedGames: (article.gameLinks ?? []).map((link) => ({
      catalogGameId: link.catalogGameId,
      relation: link.relation
    })),
    ...(includeInternal
      ? {
        id: article.id,
        authorUserId: article.authorUserId,
        scheduledFor: article.scheduledFor ? article.scheduledFor.toISOString() : null,
        aiDraftUsed: article.aiDraftUsed,
        createdAt: article.createdAt.toISOString(),
        updatedAt: article.updatedAt.toISOString()
      }
      : {})
  };
}

function assertTransitionAllowed(fromStatus, toStatus) {
  if (!ALLOWED_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    throw new AppError(409, 'ARTICLE_TRANSITION_NOT_ALLOWED',
      `An article cannot move from ${fromStatus} to ${toStatus}`);
  }
}

async function getPublishedArticleBySlug({ slug }) {
  const article = await prisma.editorialArticle.findFirst({
    where: { slug, status: { in: [...PUBLICLY_READABLE_STATUSES] } },
    select: ARTICLE_SELECT
  });

  if (!article) {
    throw new AppError(404, 'ARTICLE_NOT_FOUND', 'Article could not be found');
  }

  return mapArticle(article);
}

async function createArticle({ actorUserId, input, now = new Date() }) {
  // An AI-assisted draft may only ever be created as DRAFT.
  const status = 'DRAFT';

  try {
    const article = await prisma.$transaction(async (tx) => {
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

      await tx.articleRevision.create({
        data: {
          articleId: created.id,
          revisionNumber: 1,
          status,
          headline: input.headline,
          excerpt: input.excerpt,
          bodyMarkdown: input.bodyMarkdown ?? null,
          changeNote: 'initial draft',
          aiDraft: input.aiDraftUsed === true,
          editorUserId: actorUserId
        },
        select: { id: true }
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

    return mapArticle(article, { includeInternal: true });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'ARTICLE_SLUG_TAKEN', 'An article with this slug already exists');
    }

    throw error;
  }
}

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

async function updateArticle({ actorUserId, slug, input, now = new Date() }) {
  const existing = await prisma.editorialArticle.findUnique({
    where: { slug },
    select: { id: true, status: true, headline: true, excerpt: true }
  });

  if (!existing) {
    throw new AppError(404, 'ARTICLE_NOT_FOUND', 'Article could not be found');
  }

  if (existing.status === 'RETRACTED') {
    throw new AppError(409, 'ARTICLE_RETRACTED', 'A retracted article can no longer be edited');
  }

  const article = await prisma.$transaction(async (tx) => {
    const lastRevision = await tx.articleRevision.findFirst({
      where: { articleId: existing.id },
      select: { revisionNumber: true },
      orderBy: { revisionNumber: 'desc' }
    });

    const nextStatus = input.status ?? existing.status;

    if (input.status && input.status !== existing.status) {
      assertTransitionAllowed(existing.status, input.status);
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
        ...(input.status ? { status: input.status } : {})
      },
      select: { id: true }
    });

    await tx.articleRevision.create({
      data: {
        articleId: existing.id,
        revisionNumber: (lastRevision?.revisionNumber ?? 0) + 1,
        status: nextStatus,
        headline: input.headline ?? existing.headline,
        excerpt: input.excerpt ?? existing.excerpt,
        bodyMarkdown: input.bodyMarkdown ?? null,
        changeNote: input.changeNote ?? null,
        aiDraft: input.aiDraftUsed === true,
        editorUserId: actorUserId
      },
      select: { id: true }
    });

    await attachRelations({ tx, articleId: existing.id, input, now });

    return tx.editorialArticle.findUnique({ where: { id: existing.id }, select: ARTICLE_SELECT });
  });

  logger.info('editorial-article-updated', {
    fromStatus: existing.status,
    toStatus: article.status,
    sourceCount: (input.sources ?? []).length
  });

  return mapArticle(article, { includeInternal: true });
}

async function publishArticle({ actorUserId, slug, now = new Date() }) {
  // The role is re-read from the database at publish time, not taken from the
  // token that authenticated the request.
  const canPublish = await userRoleService.hasAnyRole(actorUserId, ['EDITOR', 'ADMIN']);

  if (!canPublish) {
    throw new AppError(403, 'FORBIDDEN_ROLE', 'Publishing requires a current EDITOR or ADMIN role');
  }

  const article = await prisma.editorialArticle.findUnique({
    where: { slug },
    select: {
      id: true,
      status: true,
      aiDraftUsed: true,
      assets: { select: { rightsStatus: true, isHero: true } },
      revisions: { select: { aiDraft: true, revisionNumber: true }, orderBy: { revisionNumber: 'desc' }, take: 1 }
    }
  });

  if (!article) {
    throw new AppError(404, 'ARTICLE_NOT_FOUND', 'Article could not be found');
  }

  assertTransitionAllowed(article.status, 'PUBLISHED');

  const heroAssets = article.assets.filter((asset) => asset.isHero);
  const unresolvedHero = heroAssets.find((asset) => !CLEARED_RIGHTS_STATUSES.includes(asset.rightsStatus));

  if (unresolvedHero) {
    throw new AppError(409, 'ARTICLE_HERO_RIGHTS_UNRESOLVED',
      'An image with an unresolved rights status cannot be published as the public hero image');
  }

  const published = await prisma.$transaction(async (tx) => {
    const updated = await tx.editorialArticle.update({
      where: { id: article.id },
      data: { status: 'PUBLISHED', publishedAt: now },
      select: { id: true }
    });

    const lastRevision = await tx.articleRevision.findFirst({
      where: { articleId: article.id },
      select: { revisionNumber: true, headline: true, excerpt: true },
      orderBy: { revisionNumber: 'desc' }
    });

    await tx.articleRevision.create({
      data: {
        articleId: article.id,
        revisionNumber: (lastRevision?.revisionNumber ?? 0) + 1,
        status: 'PUBLISHED',
        headline: lastRevision?.headline ?? '',
        excerpt: lastRevision?.excerpt ?? '',
        changeNote: 'published',
        editorUserId: actorUserId
      },
      select: { id: true }
    });

    return tx.editorialArticle.findUnique({ where: { id: updated.id }, select: ARTICLE_SELECT });
  });

  logger.info('editorial-article-published', {
    aiDraftUsed: article.aiDraftUsed,
    heroAssetCount: heroAssets.length,
    roleCheckedInDatabase: true
  });

  return mapArticle(published, { includeInternal: true });
}

async function retractArticle({ actorUserId, slug, reasonCode, now = new Date() }) {
  const canRetract = await userRoleService.hasAnyRole(actorUserId, ['EDITOR', 'ADMIN']);

  if (!canRetract) {
    throw new AppError(403, 'FORBIDDEN_ROLE', 'Retracting requires a current EDITOR or ADMIN role');
  }

  const article = await prisma.editorialArticle.findUnique({
    where: { slug },
    select: { id: true, status: true }
  });

  if (!article) {
    throw new AppError(404, 'ARTICLE_NOT_FOUND', 'Article could not be found');
  }

  assertTransitionAllowed(article.status, 'RETRACTED');

  const retracted = await prisma.$transaction(async (tx) => {
    const lastRevision = await tx.articleRevision.findFirst({
      where: { articleId: article.id },
      select: { revisionNumber: true, headline: true, excerpt: true },
      orderBy: { revisionNumber: 'desc' }
    });

    await tx.editorialArticle.update({
      where: { id: article.id },
      data: { status: 'RETRACTED', retractedAt: now },
      select: { id: true }
    });

    await tx.articleRevision.create({
      data: {
        articleId: article.id,
        revisionNumber: (lastRevision?.revisionNumber ?? 0) + 1,
        status: 'RETRACTED',
        headline: lastRevision?.headline ?? '',
        excerpt: lastRevision?.excerpt ?? '',
        changeNote: `retracted:${reasonCode}`,
        editorUserId: actorUserId
      },
      select: { id: true }
    });

    return tx.editorialArticle.findUnique({ where: { id: article.id }, select: ARTICLE_SELECT });
  });

  logger.info('editorial-article-retracted', { reasonCode, roleCheckedInDatabase: true });

  return mapArticle(retracted, { includeInternal: true });
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

  return { articles: articles.map((article) => mapArticle(article, { includeInternal: true })) };
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

  return articles.map((article) => mapArticle(article));
}

module.exports = {
  ALLOWED_TRANSITIONS,
  CLEARED_RIGHTS_STATUSES,
  PUBLICLY_READABLE_STATUSES,
  assertTransitionAllowed,
  createArticle,
  getPublishedArticleBySlug,
  listArticlesForEditor,
  listPublishedArticles,
  mapArticle,
  publishArticle,
  retractArticle,
  updateArticle
};
