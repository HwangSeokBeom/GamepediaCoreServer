const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/error-response');

const uploadsRootDirectory = path.resolve(process.cwd(), 'uploads');
const profileImagesDirectory = path.resolve(uploadsRootDirectory, 'profile-images');
const publicProfileImagePathPrefix = '/uploads/profile-images';
const publicProfileImagePathPrefixWithSlash = `${publicProfileImagePathPrefix}/`;

// The one host we can prove serves our own uploads. Absolute URLs whose origin
// does not match this are foreign hosts and can never be owned local files.
const localApiOrigin = (() => {
  try {
    return env.apiPublicBaseUrl ? new URL(env.apiPublicBaseUrl).origin : null;
  } catch (error) {
    return null;
  }
})();

const mimeTypeToExtensionMap = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

// Canonical server generator: `<uuid>-<epochMillis>-<16 hex chars><ext>`.
// The uuid prefix is the deleting user's id, so a filename matching this shape
// AND carrying the expected owner is proof of ownership — no separate record
// is needed. Extensions mirror mimeTypeToExtensionMap plus the `.bin` fallback.
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const uuidRegExp = new RegExp(`^${uuidPattern}$`, 'i');
const generatedTailRegExp = /^\d{1,20}-[0-9a-f]{16}\.(?:jpg|png|webp|bin)$/;

// Sanitized reason codes. Never carry user-controlled URLs or paths off the
// server; only these stable identifiers are ever logged.
const REJECTION_REASONS = Object.freeze({
  NOT_A_STRING: 'NOT_A_STRING',
  EMPTY: 'EMPTY',
  NULL_BYTE: 'NULL_BYTE',
  UNPARSEABLE: 'UNPARSEABLE',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
  FOREIGN_HOST: 'FOREIGN_HOST',
  QUERY_OR_FRAGMENT: 'QUERY_OR_FRAGMENT',
  ENCODED_CHARACTER: 'ENCODED_CHARACTER',
  ALTERNATE_SEPARATOR: 'ALTERNATE_SEPARATOR',
  TRAVERSAL: 'TRAVERSAL',
  REPEATED_SEPARATOR: 'REPEATED_SEPARATOR',
  OUTSIDE_PREFIX: 'OUTSIDE_PREFIX',
  NESTED_PATH: 'NESTED_PATH',
  NONCANONICAL_FILENAME: 'NONCANONICAL_FILENAME',
  OWNER_UNKNOWN: 'OWNER_UNKNOWN',
  OWNERSHIP_MISMATCH: 'OWNERSHIP_MISMATCH',
  SYMLINK: 'SYMLINK'
});

const DELETE_STATUS = Object.freeze({
  DELETED: 'DELETED',
  MISSING: 'MISSING',
  REJECTED: 'REJECTED',
  RETRY: 'RETRY'
});

function ensureProfileImagesDirectory() {
  fs.mkdirSync(profileImagesDirectory, { recursive: true });
}

function buildProfileImageFileName(userId, mimeType) {
  const extension = mimeTypeToExtensionMap[mimeType] ?? '.bin';

  return `${userId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;
}

const storage = multer.diskStorage({
  destination(req, file, callback) {
    try {
      ensureProfileImagesDirectory();
      callback(null, profileImagesDirectory);
    } catch (error) {
      callback(error);
    }
  },
  filename(req, file, callback) {
    callback(null, buildProfileImageFileName(req.auth.userId, file.mimetype));
  }
});

const profileImageUploader = multer({
  storage,
  limits: {
    fileSize: env.profileImageMaxSizeBytes
  },
  fileFilter(req, file, callback) {
    if (!mimeTypeToExtensionMap[file.mimetype]) {
      callback(new AppError(400, 'INVALID_PROFILE_IMAGE_TYPE', 'Profile image must be a JPEG, PNG, or WEBP file'));
      return;
    }

    callback(null, true);
  }
});

function uploadProfileImage(req, res, next) {
  profileImageUploader.single('image')(req, res, next);
}

function requireProfileImageFile(req, res, next) {
  if (!req.file) {
    next(new AppError(400, 'PROFILE_IMAGE_REQUIRED', 'Profile image file is required'));
    return;
  }

  next();
}

function buildStoredProfileImagePath(fileName) {
  return `${publicProfileImagePathPrefix}/${fileName}`;
}

function rejected(reason) {
  return { ok: false, reason };
}

// Reduces any accepted input to the public pathname of a same-host upload, or
// rejects it. Absolute foreign-host URLs, query/fragment ambiguity, and
// unsupported schemes are refused here; the pathname's own shape is validated
// by the caller.
function extractLocalPathname(rawValue) {
  const value = rawValue.trim();

  if (!value) {
    return rejected(REJECTION_REASONS.EMPTY);
  }

  if (value.includes('\0')) {
    return rejected(REJECTION_REASONS.NULL_BYTE);
  }

  // Absolute URL: only accept when its origin is provably our own API host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed;

    try {
      parsed = new URL(value);
    } catch (error) {
      return rejected(REJECTION_REASONS.UNPARSEABLE);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return rejected(REJECTION_REASONS.UNSUPPORTED_SCHEME);
    }

    if (!localApiOrigin || parsed.origin !== localApiOrigin) {
      return rejected(REJECTION_REASONS.FOREIGN_HOST);
    }

    if (parsed.search || parsed.hash) {
      return rejected(REJECTION_REASONS.QUERY_OR_FRAGMENT);
    }

    return { ok: true, pathname: parsed.pathname };
  }

  // Protocol-relative ("//host/...") is a foreign host in disguise.
  if (value.startsWith('//')) {
    return rejected(REJECTION_REASONS.FOREIGN_HOST);
  }

  // Otherwise it must be a site-relative path. Reject any query/fragment so a
  // relative "path?x=..#.." can never smuggle ambiguity past the shape checks.
  if (!value.startsWith('/')) {
    return rejected(REJECTION_REASONS.OUTSIDE_PREFIX);
  }

  if (value.includes('?') || value.includes('#')) {
    return rejected(REJECTION_REASONS.QUERY_OR_FRAGMENT);
  }

  return { ok: true, pathname: value };
}

// The single source of truth for "is this an app-owned profile image for this
// user?". Returns a canonical relative reference or a sanitized rejection.
// Never touches the filesystem — purely validates URL/path shape and ownership.
function resolveOwnedProfileImageReference({ profileImageUrl, userId }) {
  if (typeof profileImageUrl !== 'string') {
    return rejected(REJECTION_REASONS.NOT_A_STRING);
  }

  if (typeof userId !== 'string' || !uuidRegExp.test(userId)) {
    return rejected(REJECTION_REASONS.OWNER_UNKNOWN);
  }

  const extracted = extractLocalPathname(profileImageUrl);

  if (!extracted.ok) {
    return extracted;
  }

  const { pathname } = extracted;

  if (pathname.includes('%')) {
    return rejected(REJECTION_REASONS.ENCODED_CHARACTER);
  }

  if (pathname.includes('\\')) {
    return rejected(REJECTION_REASONS.ALTERNATE_SEPARATOR);
  }

  if (pathname.includes('//')) {
    return rejected(REJECTION_REASONS.REPEATED_SEPARATOR);
  }

  if (!pathname.startsWith(publicProfileImagePathPrefixWithSlash)) {
    return rejected(REJECTION_REASONS.OUTSIDE_PREFIX);
  }

  const fileName = pathname.slice(publicProfileImagePathPrefixWithSlash.length);

  if (!fileName || fileName.includes('/')) {
    return rejected(REJECTION_REASONS.NESTED_PATH);
  }

  if (fileName === '.' || fileName === '..' || fileName.includes('..')) {
    return rejected(REJECTION_REASONS.TRAVERSAL);
  }

  const ownerPrefix = `${userId}-`;

  if (!fileName.toLowerCase().startsWith(ownerPrefix.toLowerCase())) {
    // Either a different user's canonical file or a name with no owner segment.
    return rejected(
      uuidRegExp.test(fileName.slice(0, 36)) ? REJECTION_REASONS.OWNERSHIP_MISMATCH : REJECTION_REASONS.NONCANONICAL_FILENAME
    );
  }

  const generatedTail = fileName.slice(ownerPrefix.length);

  if (!generatedTailRegExp.test(generatedTail)) {
    return rejected(REJECTION_REASONS.NONCANONICAL_FILENAME);
  }

  // Always normalize to the canonical relative form, dropping any host so the
  // stored reference is unambiguous regardless of how it arrived.
  return {
    ok: true,
    fileName,
    storedPathname: `${publicProfileImagePathPrefix}/${fileName}`
  };
}

// Backward-compatible helper retained for callers that only need the canonical
// pathname string. Requires the owning userId; returns null when not provable.
function extractStoredProfileImagePathname(profileImageUrl, userId) {
  const resolved = resolveOwnedProfileImageReference({ profileImageUrl, userId });

  return resolved.ok ? resolved.storedPathname : null;
}

// Resolves a validated reference to the exact file to unlink, strictly beneath
// the real (symlink-resolved) profile-images directory, or returns a rejection.
function resolveOwnedProfileImageFilePath({ storedPathname, userId }) {
  const resolved = resolveOwnedProfileImageReference({ profileImageUrl: storedPathname, userId });

  if (!resolved.ok) {
    return resolved;
  }

  let canonicalDirectory;

  try {
    canonicalDirectory = fs.realpathSync(profileImagesDirectory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // No directory means no owned files exist; treat as nothing to delete.
      return { ok: true, filePath: null };
    }

    return { ok: false, reason: null, transient: true };
  }

  const candidate = path.join(canonicalDirectory, resolved.fileName);

  // The filename carries no separators, so the join must land directly inside
  // the canonical directory; anything else is a normalization surprise.
  if (path.dirname(candidate) !== canonicalDirectory) {
    return rejected(REJECTION_REASONS.NESTED_PATH);
  }

  return { ok: true, filePath: candidate, fileName: resolved.fileName };
}

// Idempotent, revalidating deletion. Returns a structured status:
//   DELETED  – owned file removed
//   MISSING  – nothing to delete (already gone / no directory)
//   REJECTED – path is not a provably-owned file; permanent, security-recorded
//   RETRY    – transient filesystem failure; retain for bounded retry
async function deleteOwnedProfileImage({ storedPathname, userId }) {
  const resolution = resolveOwnedProfileImageFilePath({ storedPathname, userId });

  if (!resolution.ok) {
    if (resolution.transient) {
      return { status: DELETE_STATUS.RETRY, reason: null };
    }

    return { status: DELETE_STATUS.REJECTED, reason: resolution.reason };
  }

  if (!resolution.filePath) {
    return { status: DELETE_STATUS.MISSING };
  }

  let stats;

  try {
    stats = await fs.promises.lstat(resolution.filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: DELETE_STATUS.MISSING };
    }

    return { status: DELETE_STATUS.RETRY, reason: null };
  }

  // Owned images are always regular files. A symlink here is an escape attempt.
  if (stats.isSymbolicLink()) {
    return { status: DELETE_STATUS.REJECTED, reason: REJECTION_REASONS.SYMLINK };
  }

  try {
    await fs.promises.unlink(resolution.filePath);

    return { status: DELETE_STATUS.DELETED };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { status: DELETE_STATUS.MISSING };
    }

    // EISDIR / EPERM / EACCES etc. — a transient or repairable condition.
    return { status: DELETE_STATUS.RETRY, reason: null };
  }
}

module.exports = {
  DELETE_STATUS,
  REJECTION_REASONS,
  buildStoredProfileImagePath,
  deleteOwnedProfileImage,
  extractStoredProfileImagePathname,
  profileImagesDirectory,
  requireProfileImageFile,
  resolveOwnedProfileImageReference,
  uploadProfileImage,
  uploadsRootDirectory
};
