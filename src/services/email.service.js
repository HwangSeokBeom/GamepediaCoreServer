const nodemailer = require('nodemailer');
const { env } = require('../config/env');

let transporter;
let testMailSink = null;

// Reason codes that are safe to log and to surface on thrown errors. Raw
// transport errors may embed the recipient address or the full message, so
// everything else collapses to a generic code.
const SAFE_TRANSPORT_ERROR_CODES = new Set([
  'EAUTH',
  'ECONNECTION',
  'ECONNREFUSED',
  'EDNS',
  'EENVELOPE',
  'EMESSAGE',
  'ESOCKET',
  'ETIMEDOUT'
]);

class MailDeliveryError extends Error {
  constructor(reasonCode) {
    super(`Mail delivery failed: ${reasonCode}`);
    this.name = 'MailDeliveryError';
    this.code = 'MAIL_DELIVERY_FAILED';
    this.reasonCode = reasonCode;
  }
}

function toSafeReasonCode(error) {
  const rawCode = typeof error?.code === 'string' ? error.code.toUpperCase() : null;

  return rawCode && SAFE_TRANSPORT_ERROR_CODES.has(rawCode) ? rawCode.toLowerCase() : 'transport_error';
}

function createSmtpTransporter() {
  if (!env.mailHost || !env.mailUser || !env.mailPassword) {
    throw new MailDeliveryError('smtp_config_incomplete');
  }

  return nodemailer.createTransport({
    host: env.mailHost,
    port: env.mailPort,
    secure: env.mailSecure,
    auth: {
      user: env.mailUser,
      pass: env.mailPassword
    }
  });
}

function getTransporter() {
  if (!transporter) {
    transporter = createSmtpTransporter();
  }

  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  if (env.mailMode === 'log') {
    // Non-sending mode: the message (which may carry credentials such as a
    // password-reset URL) is handed only to the optional test sink, never to
    // console output.
    if (testMailSink) {
      testMailSink({ to, subject, text, html });
    }

    console.info('[email] event=mail_generated mode=log delivery=skipped');
    return { mode: 'log' };
  }

  if (env.mailMode !== 'smtp') {
    throw new MailDeliveryError('unsupported_mail_mode');
  }

  try {
    const info = await getTransporter().sendMail({
      from: env.mailFrom,
      to,
      subject,
      text,
      html
    });

    console.info('[email] event=mail_sent mode=smtp');

    return { mode: 'smtp', messageId: info?.messageId ?? null };
  } catch (error) {
    const reasonCode = error instanceof MailDeliveryError ? error.reasonCode : toSafeReasonCode(error);

    console.error(`[email] event=mail_send_failed mode=smtp reason=${reasonCode}`);

    throw new MailDeliveryError(reasonCode);
  }
}

function setTransporterForTesting(value) {
  if (env.nodeEnv !== 'test' && env.nodeEnv !== 'development') {
    throw new Error('setTransporterForTesting is only available in development or test');
  }

  transporter = value ?? undefined;
}

function setMailSinkForTesting(sink) {
  if (env.nodeEnv !== 'test' && env.nodeEnv !== 'development') {
    throw new Error('setMailSinkForTesting is only available in development or test');
  }

  testMailSink = typeof sink === 'function' ? sink : null;
}

module.exports = {
  MailDeliveryError,
  sendMail,
  setMailSinkForTesting,
  setTransporterForTesting
};
