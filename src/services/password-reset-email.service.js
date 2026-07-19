const { env } = require('../config/env');
const emailService = require('./email.service');

function buildPasswordResetUrl(token) {
  const resetUrl = new URL('/reset-password', env.appWebBaseUrl);
  resetUrl.searchParams.set('token', token);
  return resetUrl.toString();
}

function buildPasswordResetMessage(resetUrl) {
  return {
    subject: 'GamePedia password reset instructions',
    text: [
      'You requested a password reset for your GamePedia account.',
      '',
      `Reset your password: ${resetUrl}`,
      '',
      `This link expires in ${env.passwordResetTokenTtlMinutes} minutes.`,
      'If you did not request this, you can ignore this email.'
    ].join('\n'),
    html: [
      '<p>You requested a password reset for your GamePedia account.</p>',
      `<p><a href="${resetUrl}">Reset your password</a></p>`,
      `<p>This link expires in ${env.passwordResetTokenTtlMinutes} minutes.</p>`,
      '<p>If you did not request this, you can ignore this email.</p>'
    ].join('')
  };
}

async function sendPasswordResetInstructions({ email, token }) {
  const resetUrl = buildPasswordResetUrl(token);
  const message = buildPasswordResetMessage(resetUrl);

  // The reset URL is a bearer credential: it may only flow into the mail
  // transport. Logging is restricted to sanitized delivery metadata.
  const delivery = await emailService.sendMail({
    to: email,
    subject: message.subject,
    text: message.text,
    html: message.html
  });

  console.info(
    `[password-reset:email] event=dispatched mode=${env.mailMode} ttlMinutes=${env.passwordResetTokenTtlMinutes}`
  );

  return { mode: delivery.mode };
}

module.exports = {
  sendPasswordResetInstructions
};
