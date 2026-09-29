// services/httpEmail.js
// Sends mail over the provider's HTTPS API instead of SMTP.
//
// Why this exists: Render blocks outbound SMTP. Probing smtp.gmail.com from the
// production service times out at the TCP connect stage on every port —
// 465, 587 and 25 all return ETIMEDOUT with command "CONN" and no SMTP response
// code, each at exactly the 7 s connection timeout, while the same code and
// credentials connect from a laptop in about 2 s. No Nodemailer setting can fix
// a blocked port, so the OTP mail goes out over HTTPS (port 443), which is not
// blocked — that is how the app already reaches MongoDB Atlas.
//
// This module only sends. OTP generation, storage, expiry and verification are
// unchanged and stay in routes/auth.js with MongoDB.
//
// Configuration: set EMAIL_API_KEY. The provider is detected from the key's own
// prefix, so there is nothing else to choose:
//
//   re_...       Resend   POST https://api.resend.com/emails
//   xkeysib-...  Brevo    POST https://api.brevo.com/v3/smtp/email
//
// EMAIL_PROVIDER overrides the detection if a key format ever changes.
// The sender address is EMAIL_FROM, falling back to EMAIL_USER, and must be an
// address the provider has verified. The key is read from the environment on the
// server only and is never logged, returned, or sent to the browser.

const PROVIDERS = {
  resend: {
    label: 'resend',
    endpoint: 'https://api.resend.com/emails',
    verifyEndpoint: 'https://api.resend.com/domains',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    body: ({ fromName, from, to, subject, html }) => ({
      from: fromName ? `${fromName} <${from}>` : from,
      to: [to],
      subject,
      html,
    }),
    messageId: (json) => json?.id || null,
  },
  brevo: {
    label: 'brevo',
    endpoint: 'https://api.brevo.com/v3/smtp/email',
    verifyEndpoint: 'https://api.brevo.com/v3/account',
    headers: (key) => ({ 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' }),
    body: ({ fromName, from, to, subject, html }) => ({
      sender: fromName ? { email: from, name: fromName } : { email: from },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
    messageId: (json) => json?.messageId || null,
  },
};

function apiKey() {
  return String(process.env.EMAIL_API_KEY || '').trim();
}

// Detected from the key prefix so a pasted key just works; EMAIL_PROVIDER wins
// when set, for a key format this does not recognise.
function providerName() {
  const explicit = String(process.env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (explicit && PROVIDERS[explicit]) return explicit;
  const key = apiKey();
  if (key.startsWith('re_')) return 'resend';
  if (key.startsWith('xkeysib-')) return 'brevo';
  return explicit || null;
}

function senderAddress() {
  return String(process.env.EMAIL_FROM || process.env.EMAIL_USER || '').trim();
}

// True when this transport can be used at all. A key whose provider cannot be
// identified is deliberately NOT usable — guessing the wrong API shape would
// fail at send time, which is exactly the opaque failure this replaces.
function httpEmailConfigured() {
  const name = providerName();
  return Boolean(apiKey() && name && PROVIDERS[name] && senderAddress());
}

function describe() {
  const name = providerName();
  return {
    kind: 'https-api',
    provider: name || 'unknown',
    endpoint: name && PROVIDERS[name] ? PROVIDERS[name].endpoint : null,
    senderConfigured: Boolean(senderAddress()),
  };
}

// Normalises a failure into the same shape a Nodemailer error has, so the
// caller's classifier labels HTTP and SMTP failures the same way.
function mailError(message, { code, responseCode = null, command = 'API' } = {}) {
  const err = new Error(message);
  err.code = code;
  err.responseCode = responseCode;
  err.command = command;
  return err;
}

async function requestWithin(url, init, budgetMs) {
  if (typeof fetch !== 'function') {
    throw mailError('global fetch is unavailable — Node 18 or newer is required', { code: 'ENOFETCH' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // An aborted request is our own deadline; anything else is the network
    // failing to reach the provider. Both map onto the existing labels.
    if (err?.name === 'AbortError') {
      throw mailError(`MAIL_TIMEOUT after ${budgetMs}ms`, { code: 'ETIMEDOUT', command: 'CONN' });
    }
    const cause = err?.cause?.code || err?.code || 'ECONNECTION';
    throw mailError(`Could not reach the email API: ${cause}`, { code: cause, command: 'CONN' });
  } finally {
    clearTimeout(timer);
  }
}

// Reads the provider's error text for the log without letting an unbounded or
// sensitive body through. Never includes the API key.
async function safeErrorDetail(response) {
  try {
    const text = (await response.text()).slice(0, 300);
    return text.replace(/re_[A-Za-z0-9_-]+|xkeysib-[A-Za-z0-9_-]+/g, '[redacted]');
  } catch {
    return '';
  }
}

async function sendViaHttp({ to, subject, html, fromName = 'KinderCura' }, budgetMs = 15000) {
  const name = providerName();
  const provider = PROVIDERS[name];
  if (!provider) throw mailError('No usable EMAIL_API_KEY / EMAIL_PROVIDER', { code: 'ENOPROVIDER' });
  const from = senderAddress();
  if (!from) throw mailError('No sender address (EMAIL_FROM or EMAIL_USER)', { code: 'ENOSENDER' });

  const response = await requestWithin(provider.endpoint, {
    method: 'POST',
    headers: provider.headers(apiKey()),
    body: JSON.stringify(provider.body({ fromName, from, to, subject, html })),
  }, budgetMs);

  if (!response.ok) {
    const detail = await safeErrorDetail(response);
    // 401/403 is a bad or unauthorised key — the HTTPS equivalent of SMTP 535,
    // so it is reported as an authentication fault rather than a send fault.
    const code = response.status === 401 || response.status === 403 ? 'EAUTH' : `EHTTP_${response.status}`;
    throw mailError(`Email API returned ${response.status}: ${detail}`, {
      code,
      responseCode: response.status === 401 || response.status === 403 ? 535 : response.status,
    });
  }

  const json = await response.json().catch(() => ({}));
  return { messageId: provider.messageId(json), provider: provider.label };
}

// Checks the key without sending anything: both providers expose a cheap
// authenticated GET that fails with 401 on a bad key.
async function verifyHttpEmail(budgetMs = 10000) {
  const name = providerName();
  const provider = PROVIDERS[name];
  if (!provider) throw mailError('No usable EMAIL_API_KEY / EMAIL_PROVIDER', { code: 'ENOPROVIDER' });

  const response = await requestWithin(provider.verifyEndpoint, {
    method: 'GET',
    headers: provider.headers(apiKey()),
  }, budgetMs);

  if (response.status === 401 || response.status === 403) {
    throw mailError(`Email API rejected the key (${response.status})`, { code: 'EAUTH', responseCode: 535 });
  }
  if (!response.ok) {
    const detail = await safeErrorDetail(response);
    throw mailError(`Email API returned ${response.status}: ${detail}`, {
      code: `EHTTP_${response.status}`,
      responseCode: response.status,
    });
  }
  return true;
}

module.exports = { httpEmailConfigured, sendViaHttp, verifyHttpEmail, describe, providerName };
