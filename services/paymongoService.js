// services/paymongoService.js
// Thin wrapper over the PayMongo REST API. This module is the ONLY place that
// touches PAYMONGO_SECRET_KEY — nothing here is ever imported by browser code.
//
// Endpoint choice: PayMongo now documents `POST /v2/checkout_sessions` as the
// recommended Checkout Session API for new integrations, so that is the
// default. PAYMONGO_API_VERSION can be set to 'v1' to fall back to the older
// `POST /checkout_sessions` without a code change.
//
// Webhook events: v1 emits `checkout_session.payment.paid`, while the current
// event catalogue is centred on `payment.paid` / `payment.failed`. The webhook
// handler in controllers/paymentController.js accepts both, so the integration
// keeps working whichever the dashboard is subscribed to.

const crypto = require('crypto');

const API_BASE = 'https://api.paymongo.com';
const API_VERSION = process.env.PAYMONGO_API_VERSION === 'v1' ? 'v1' : 'v2';

/** True when the server has enough configuration to talk to PayMongo. */
function isConfigured() {
  return Boolean(process.env.PAYMONGO_SECRET_KEY);
}

/** True when the configured key is a test-mode key (sk_test_...). */
function isTestMode() {
  return String(process.env.PAYMONGO_SECRET_KEY || '').startsWith('sk_test');
}

function authHeader() {
  const key = process.env.PAYMONGO_SECRET_KEY;
  if (!key) {
    throw new Error('PAYMONGO_SECRET_KEY is not configured on the server.');
  }
  // PayMongo uses HTTP Basic with the secret key as the username and no password.
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

async function callApi(method, path, body = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    // PayMongo returns { errors: [{ detail, code }] }. Surface the detail so an
    // operator can see "amount below minimum" instead of a bare 400.
    const detail = json?.errors?.map((e) => e.detail).filter(Boolean).join('; ');
    const err = new Error(detail || `PayMongo ${method} ${path} failed with HTTP ${res.status}`);
    err.statusCode = res.status;
    err.paymongoErrors = json?.errors || null;
    throw err;
  }
  return json;
}

/** PayMongo works in centavos; our records are in pesos. */
function toCentavos(pesos) {
  return Math.round(Number(pesos) * 100);
}

/**
 * Create a hosted Checkout Session.
 *
 * `referenceNumber` is our own KC-PAY-... value. It is echoed back on the
 * webhook, and also duplicated into metadata, which is what lets the webhook
 * find the right Payment row without trusting anything the browser sends.
 */
async function createCheckoutSession({
  referenceNumber,
  amount,
  currency = 'PHP',
  lineName,
  lineDescription,
  successUrl,
  cancelUrl,
  customerEmail = null,
  customerName = null,
  paymentMethods = ['gcash', 'paymaya', 'card'],
  metadata = {},
  sendEmailReceipt = false,
}) {
  const centavos = toCentavos(amount);
  if (!Number.isFinite(centavos) || centavos <= 0) {
    throw new Error('Checkout amount must be greater than zero.');
  }

  const attributes = {
    line_items: [{
      name: lineName,
      quantity: 1,
      amount: centavos,
      currency,
      description: lineDescription || undefined,
    }],
    payment_method_types: paymentMethods,
    reference_number: referenceNumber,
    description: lineDescription || lineName,
    // KinderCura issues its own receipt, so PayMongo's is off by default to
    // avoid the parent receiving two different-looking receipts.
    send_email_receipt: Boolean(sendEmailReceipt),
    metadata: { ...metadata, kc_payment_ref: referenceNumber },
  };
  if (successUrl) attributes.success_url = successUrl;
  if (cancelUrl) attributes.cancel_url = cancelUrl;
  if (customerEmail) attributes.customer_email = customerEmail;
  if (customerName || customerEmail) {
    attributes.billing = {
      name: customerName || undefined,
      email: customerEmail || undefined,
    };
  }

  const path = API_VERSION === 'v1' ? '/v1/checkout_sessions' : '/v2/checkout_sessions';
  const json = await callApi('POST', path, { data: { attributes } });

  const data = json?.data || {};
  const attrs = data.attributes || {};
  return {
    id: data.id || null,
    checkoutUrl: attrs.checkout_url || null,
    // v1 nests a payment_intent; v2 does not always return one at creation.
    paymentIntentId: attrs.payment_intent?.id || attrs.payment_intent_id || null,
    raw: json,
  };
}

/** Retrieve a Checkout Session so the server can confirm status itself. */
async function retrieveCheckoutSession(sessionId) {
  const path = API_VERSION === 'v1'
    ? `/v1/checkout_sessions/${encodeURIComponent(sessionId)}`
    : `/v2/checkout_sessions/${encodeURIComponent(sessionId)}`;
  return callApi('GET', path);
}

/**
 * Pull the paid/unpaid verdict out of a Checkout Session payload.
 * Used by the reconcile path, which asks PayMongo directly rather than
 * believing the browser that landed on our success URL.
 */
function readSessionOutcome(sessionJson) {
  const attrs = sessionJson?.data?.attributes || {};
  const payments = Array.isArray(attrs.payments) ? attrs.payments : [];
  const paid = payments.find((p) => (p?.attributes?.status || p?.status) === 'paid') || null;

  // v2 exposes a top-level payment_status; v1 is inferred from the payments array.
  const status = attrs.payment_status || attrs.status || null;
  const isPaid = Boolean(paid) || status === 'paid';

  return {
    isPaid,
    status,
    paymentId: paid?.id || null,
    paymentIntentId: attrs.payment_intent?.id || attrs.payment_intent_id || null,
    referenceNumber: attrs.reference_number || attrs.metadata?.kc_payment_ref || null,
    amount: paid?.attributes?.amount ?? null,
  };
}

/**
 * Verify a webhook signature.
 *
 * PayMongo sends `Paymongo-Signature: t=<unix>,te=<test sig>,li=<live sig>`.
 * The signed payload is `${t}.${rawBody}`, HMAC-SHA256 with the webhook secret.
 * `te` is checked in test mode and `li` in live mode.
 *
 * `rawBody` MUST be the exact bytes PayMongo sent — see the express.json
 * `verify` hook in server.js, which stashes them on req.rawBody. Re-serialising
 * the parsed object would change the bytes and break every valid signature.
 */
function verifyWebhookSignature({ rawBody, signatureHeader, secret, toleranceSeconds = 300 }) {
  if (!secret) return { ok: false, reason: 'PAYMONGO_WEBHOOK_SECRET is not configured.' };
  if (!signatureHeader) return { ok: false, reason: 'Missing Paymongo-Signature header.' };
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'Missing raw request body.' };

  const parts = {};
  for (const chunk of String(signatureHeader).split(',')) {
    const idx = chunk.indexOf('=');
    if (idx > 0) parts[chunk.slice(0, idx).trim()] = chunk.slice(idx + 1).trim();
  }

  const timestamp = parts.t;
  const provided = isTestMode() ? parts.te : parts.li;
  if (!timestamp || !provided) {
    return { ok: false, reason: 'Signature header is missing its timestamp or mode signature.' };
  }

  // Reject stale signatures so a captured request cannot be replayed later.
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > toleranceSeconds) {
    return { ok: false, reason: 'Signature timestamp is outside the allowed tolerance.' };
  }

  const payload = `${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(provided), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Signature mismatch.' };
  }
  return { ok: true };
}

module.exports = {
  API_VERSION,
  isConfigured,
  isTestMode,
  createCheckoutSession,
  retrieveCheckoutSession,
  readSessionOutcome,
  verifyWebhookSignature,
  toCentavos,
};
