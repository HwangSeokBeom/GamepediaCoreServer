const authService = require('../services/auth.service');
const { successResponse } = require('../utils/api-response');
const { asyncHandler } = require('../utils/async-handler');

const signUp = asyncHandler(async (req, res) => {
  const result = await authService.signUp(req.body);
  res.status(201).json(successResponse(result));
});

const appleLogin = asyncHandler(async (req, res) => {
  const result = await authService.appleLogin(req.body);
  res.status(200).json(successResponse(result));
});

const googleLogin = asyncHandler(async (req, res) => {
  const result = await authService.googleLogin(req.body);
  res.status(200).json(successResponse(result));
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  res.status(200).json(successResponse(result));
});

const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.body);
  res.status(200).json(successResponse(result));
});

const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.body);
  res.status(200).json(successResponse(result));
});

const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body);
  res.status(200).json(successResponse(result));
});

const logout = asyncHandler(async (req, res) => {
  const result = await authService.logout(req.body);
  res.status(200).json(successResponse(result));
});

const me = asyncHandler(async (req, res) => {
  const user = await authService.getCurrentUser(req.auth.userId);
  res.status(200).json(successResponse({ user }));
});

const deleteMyAccount = asyncHandler(async (req, res) => {
  const result = await authService.deleteCurrentUser(req.auth.userId);
  res.status(200).json(successResponse(result));
});

module.exports = {
  appleLogin,
  deleteMyAccount,
  forgotPassword,
  googleLogin,
  login,
  logout,
  me,
  refresh,
  resetPassword,
  signUp
};
