const nodemailer = require('nodemailer');
const { env } = require('../config/env');

let transporter;

function createSmtpTransporter() {
  if (!env.mailHost || !env.mailUser || !env.mailPassword) {
    throw new Error('SMTP mail configuration is incomplete');
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
    console.info(`[email] mode=log to=${to} from=${env.mailFrom} subject=${subject}`);
    console.info(`[email] text=${text}`);
    return { mode: 'log' };
  }

  if (env.mailMode !== 'smtp') {
    throw new Error(`MAIL_MODE ${env.mailMode} is not supported`);
  }

  const smtpTransporter = getTransporter();
  const info = await smtpTransporter.sendMail({
    from: env.mailFrom,
    to,
    subject,
    text,
    html
  });

  console.info(
    `[email] mode=smtp to=${to} from=${env.mailFrom} subject=${subject} messageId=${info.messageId}`
  );

  return info;
}

module.exports = {
  sendMail
};
