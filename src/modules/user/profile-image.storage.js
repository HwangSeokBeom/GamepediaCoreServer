const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { env } = require('../../config/env');
const { AppError } = require('../../utils/error-response');

const uploadsRootDirectory = path.resolve(process.cwd(), 'uploads');
const profileImagesDirectory = path.resolve(uploadsRootDirectory, 'profile-images');
const publicProfileImagePathPrefix = '/uploads/profile-images';

const mimeTypeToExtensionMap = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

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

function extractStoredProfileImagePathname(profileImageUrl) {
  if (typeof profileImageUrl !== 'string') {
    return null;
  }

  const normalizedProfileImageUrl = profileImageUrl.trim();

  if (!normalizedProfileImageUrl) {
    return null;
  }

  if (normalizedProfileImageUrl.startsWith(`${publicProfileImagePathPrefix}/`)) {
    return normalizedProfileImageUrl;
  }

  try {
    const parsedUrl = new URL(normalizedProfileImageUrl);

    if (parsedUrl.pathname.startsWith(`${publicProfileImagePathPrefix}/`)) {
      return parsedUrl.pathname;
    }
  } catch (error) {
    return null;
  }

  return null;
}

function resolveStoredProfileImageFilePath(profileImageUrl) {
  const storedPathname = extractStoredProfileImagePathname(profileImageUrl);

  if (!storedPathname) {
    return null;
  }

  const relativeUploadPath = storedPathname.replace(/^\/uploads\//, '');
  const resolvedFilePath = path.resolve(uploadsRootDirectory, relativeUploadPath);

  if (resolvedFilePath !== uploadsRootDirectory && !resolvedFilePath.startsWith(`${uploadsRootDirectory}${path.sep}`)) {
    return null;
  }

  return resolvedFilePath;
}

async function deleteStoredProfileImage(profileImageUrl) {
  const filePath = resolveStoredProfileImageFilePath(profileImageUrl);

  if (!filePath) {
    return false;
  }

  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

module.exports = {
  buildStoredProfileImagePath,
  deleteStoredProfileImage,
  requireProfileImageFile,
  uploadProfileImage,
  uploadsRootDirectory
};
