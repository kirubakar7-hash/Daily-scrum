import nodemailer from 'nodemailer';

let cachedTransporter = null;

/** Reads SMTP_* from the environment on first use (not at import time, so a missing .env during local
 *  dev/tests never breaks startup) and reuses one transporter afterward. Returns null — not a thrown
 *  error — when nothing's configured yet, so callers can show a clear "not set up" message instead of
 *  a raw crash. */
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  cachedTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return cachedTransporter;
}

export function mailIsConfigured() {
  return !!getTransporter();
}

/** Who the status email goes to — a plain comma-separated list in the environment, same pattern as
 *  CORS_ORIGIN. Kept out of the database entirely: this is deployment config, not org data a Leader
 *  edits day to day, and it avoids needing a UI just to manage a handful of addresses. */
export function stakeholderRecipients() {
  return (process.env.STAKEHOLDER_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

export async function sendMail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter) {
    throw new Error('Email is not configured yet — set SMTP_HOST, SMTP_USER, and SMTP_PASS in the server .env file.');
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({ from, to, subject, html, text });
}
