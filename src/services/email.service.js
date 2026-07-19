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

class SmtpVerificationError extends Error {
  constructor(reasonCode) {
    // The message carries only the stable reason code: raw transport errors
    // can embed the host, user, or server banner text.
    super(`SMTP verification failed: ${reasonCode}`);
    this.name = 'SmtpVerificationError';
    this.code = 'SMTP_VERIFICATION_FAILED';
    this.reasonCode = reasonCode;
  }
}

function toSafeReasonCode(error) {
  const rawCode = typeof error?.code === 'string' ? error.code.toUpperCase() : null;

  return rawCode && SAFE_TRANSPORT_ERROR_CODES.has(rawCode) ? rawCode.toLowerCase() : 'transport_error';
}

const SMTP_VERIFY_DNS_CODES = new Set(['EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL']);
const SMTP_VERIFY_CONNECTION_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ESOCKET'
]);
const SMTP_VERIFY_TLS_CODES = new Set([
  'ETLS',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HOSTNAME_MISMATCH'
]);

// Collapses any transport/DNS/TLS error to one of the stable, sanitized
// startup reason codes. Never returns raw error text.
function toSmtpVerifyReasonCode(error) {
  if (error instanceof SmtpVerificationError) {
    return error.reasonCode;
  }

  if (error instanceof MailDeliveryError) {
    return 'smtp_configuration_failure';
  }

  const rawCode = typeof error?.code === 'string' ? error.code.toUpperCase() : '';

  if (SMTP_VERIFY_DNS_CODES.has(rawCode)) {
    return 'smtp_dns_failure';
  }

  if (rawCode === 'EAUTH') {
    return 'smtp_auth_failure';
  }

  if (SMTP_VERIFY_TLS_CODES.has(rawCode) || rawCode.startsWith('ERR_TLS_') || rawCode.startsWith('ERR_SSL_')) {
    return 'smtp_tls_failure';
  }

  if (rawCode === 'ETIMEDOUT') {
    return 'smtp_timeout';
  }

  if (SMTP_VERIFY_CONNECTION_CODES.has(rawCode)) {
    return 'smtp_connection_failure';
  }

  return 'smtp_transport_failure';
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

// Startup readiness state. Populated exactly once per process by
// verifyMailStartupReadiness(); read by health reporting and reused so
// concurrent callers never trigger a second SMTP round-trip.
let startupReadinessPromise = null;
let mailReadinessState = { mode: env.mailMode, verified: false, skipped: true };

function closeTransporterQuietly(target) {
  if (target && typeof target.close === 'function') {
    try {
      target.close();
    } catch (error) {
      // Closing is best-effort cleanup; the transporter is unusable anyway.
    }
  }
}

// Bounded, injectable SMTP transport verification. Uses Nodemailer's
// transport-native verify() (connect + EHLO + authenticate) raced against a
// finite timeout, and reports only stable sanitized reason codes.
async function verifySmtpTransport({ transporter: injectedTransporter, timeoutMs = env.smtpVerifyTimeoutMs } = {}) {
  let activeTransporter;

  try {
    activeTransporter = injectedTransporter ?? getTransporter();
  } catch (error) {
    console.error('[email] event=smtp_verify_failed reason=smtp_configuration_failure');
    throw new SmtpVerificationError('smtp_configuration_failure');
  }

  let timeoutHandle = null;

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new SmtpVerificationError('smtp_timeout')), timeoutMs);
  });

  try {
    await Promise.race([activeTransporter.verify(), timeoutPromise]);
  } catch (error) {
    const reasonCode = toSmtpVerifyReasonCode(error);

    // Release the socket the failed verification attempt may hold open, and
    // drop it from the cache so it cannot be reused for delivery.
    closeTransporterQuietly(activeTransporter);

    if (activeTransporter === transporter) {
      transporter = undefined;
    }

    console.error(`[email] event=smtp_verify_failed reason=${reasonCode}`);

    throw new SmtpVerificationError(reasonCode);
  } finally {
    clearTimeout(timeoutHandle);
  }

  console.info('[email] event=smtp_verified mode=smtp');

  return { verified: true };
}

// Called by the server bootstrap before listen(). Non-SMTP modes and
// development/test without an explicit SMTP_VERIFY_ON_STARTUP opt-in never
// contact a mail server. Runs at most once per process.
function verifyMailStartupReadiness(options = {}) {
  if (!startupReadinessPromise) {
    startupReadinessPromise = (async () => {
      if (env.mailMode !== 'smtp') {
        mailReadinessState = { mode: env.mailMode, verified: false, skipped: true };
        return mailReadinessState;
      }

      if (!env.smtpVerifyOnStartup) {
        mailReadinessState = { mode: 'smtp', verified: false, skipped: true };
        return mailReadinessState;
      }

      await verifySmtpTransport(options);
      mailReadinessState = { mode: 'smtp', verified: true, skipped: false };

      return mailReadinessState;
    })();
  }

  return startupReadinessPromise;
}

function getMailReadinessState() {
  return { ...mailReadinessState };
}

// Shutdown/startup-failure hook: releases pooled transport resources when the
// underlying transport supports it.
function closeMailTransport() {
  closeTransporterQuietly(transporter);
  transporter = undefined;
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

function resetMailStateForTesting() {
  if (env.nodeEnv !== 'test' && env.nodeEnv !== 'development') {
    throw new Error('resetMailStateForTesting is only available in development or test');
  }

  transporter = undefined;
  testMailSink = null;
  startupReadinessPromise = null;
  mailReadinessState = { mode: env.mailMode, verified: false, skipped: true };
}

module.exports = {
  MailDeliveryError,
  SmtpVerificationError,
  closeMailTransport,
  getMailReadinessState,
  resetMailStateForTesting,
  sendMail,
  setMailSinkForTesting,
  setTransporterForTesting,
  verifyMailStartupReadiness,
  verifySmtpTransport
};
