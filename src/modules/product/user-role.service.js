const { prisma } = require('../../config/prisma');
const { AppError } = require('../../utils/error-response');
const { asyncHandler } = require('../../utils/async-handler');
const { PRODUCT_ROLES } = require('./product.constants');

// Editor/admin capability is read from user_role_assignments at request time.
// A role claim inside a JWT is never trusted: an access token minted before a
// revocation would otherwise keep publishing privileges alive until it expired.

async function listActiveRoles(userId) {
  const assignments = await prisma.userRoleAssignment.findMany({
    where: {
      userId,
      revokedAt: null
    },
    select: { role: true }
  });

  return [...new Set(assignments.map((assignment) => assignment.role))].sort();
}

async function hasAnyRole(userId, requiredRoles) {
  const activeRoles = await listActiveRoles(userId);

  return requiredRoles.some((role) => activeRoles.includes(role));
}

/// Express guard. ADMIN is not implicitly granted: an admin who must also be
/// able to edit is given both rows, which keeps the audit trail explicit.
function requireRole(...requiredRoles) {
  const roles = requiredRoles.length > 0 ? requiredRoles : [PRODUCT_ROLES.ADMIN];

  return asyncHandler(async (req, res, next) => {
    const userId = req.auth?.userId;

    if (!userId) {
      throw new AppError(401, 'UNAUTHORIZED', 'A valid bearer access token is required');
    }

    const activeRoles = await listActiveRoles(userId);

    if (!roles.some((role) => activeRoles.includes(role))) {
      throw new AppError(403, 'FORBIDDEN_ROLE', 'The current account does not hold a required role');
    }

    req.productRoles = activeRoles;
    next();
  });
}

module.exports = {
  hasAnyRole,
  listActiveRoles,
  requireRole
};
