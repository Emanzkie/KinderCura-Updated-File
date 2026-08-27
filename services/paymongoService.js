// services/paymongoService.js
// Thin wrapper over the PayMongo REST API. This module is the ONLY place that
// touches PAYMONGO_SECRET_KEY — nothing here is ever imported by browser code.
//
// Endpoint choice: `POST /v1/checkout_sessions` is the endpoint PayMongo
// publicly documents for Checkout Sessions, so that is the default. The API
// returns 401 for *every* unauthenticated path, so a v2 path cannot be proven
// to exist without spending a live call — defaulting to the documented one
// keeps "Pay Online" from failing on an endpoint we never verified.
// PAYMONGO_API_VERSION=v2 opts in, without a code change, if the account is
// enrolled in a newer API version.
//
// Webhook events: v1 emits `checkout_session.payment.paid`, while the current
// event catalogue is centred on `payment.paid` / `payment.failed`. The webhook
// handler in controllers/paymentController.js accepts both, so the integration
// keeps working whichever the dashboard is subscribed to.

const crypto = require('crypto');

const API_BASE = 'https://api.paymongo.com';
const API_VERSION = process.env.PAYMONGO_API_VERSION === 'v2' ? 'v2' : 'v1';

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

// KinderCura online payment is e-wallet only, strictly GCash + Maya (adviser
// requirement, Aug 2026): card / debit / Visa / Mastercard / GrabPay / bank
// transfer must never be offered on the hosted checkout. This allowlist is the
// single enforcement point — whatever the caller or the stored clinic config
// asks for, only these PayMongo `payment_method_types` can reach the Checkout
// Session.
const ALLOWED_ONLINE_METHODS = ['gcash', 'paymaya'];
const DEFAULT_ONLINE_METHODS = ['gcash', 'paymaya'];

/**
 * Reduce any requested method list to the supported e-wallet allowlist.
 * Anything not on the list (card, grab_pay, bank transfer, …) is dropped; an
 * empty result falls back to GCash + Maya so checkout never goes out with no
 * methods.
 */
function sanitizeOnlineMethods(methods) {
  const list = (Array.isArray(methods) ? methods : [])
    .map((m) => String(m).trim().toLowerCase())
    .filter((m) => ALLOWED_ONLINE_METHODS.includes(m));
  return list.length ? [...new Set(list)] : [...DEFAULT_ONLINE_METHODS];
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
  paymentMethods = [...DEFAULT_ONLINE_METHODS],
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
    payment_method_types: sanitizeOnlineMethods(paymentMethods),
    reference_number: referenceNumber,
    description: lineDescription || lineName,
    // KinderCura issues its own receipt, so PayMongo's is off by default to
    // avoid the parent receiving two different-looking receipts.
    send_email_receipt: Boolean(sendEmailReceipt),
    metadata: { ...metadata, kc_payment_ref: referenceNumber },
  };
  if (successUrl) attributes.success_url = successUrl;
  if (cancelUrl) attributes.cancel_url = cancelUrl;
  // The payer's email travels in `billing`, which is the documented place for
  // it. A second top-level `customer_email` is not part of the Checkout
  // Session attribute list and risks a 400 on an otherwise valid request.
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
    // The e-wallet the payer used, e.g. 'gcash' / 'paymaya'. PayMongo puts it
    // on the paid payment's source; older/checkout-only payloads may omit it.
    sourceType: paid?.attributes?.source?.type
      || paid?.attributes?.payment_method_used
      || null,
  };
}

/**
 * Best-effort extraction of the e-wallet brand ('gcash' / 'paymaya') from a
 * webhook resource, whichever shape PayMongo delivered:
 *  - `payment.paid`            -> resource.attributes.source.type
 *  - `checkout_session.*.paid` -> resource.attributes.payments[0].attributes.source.type
 * Returns null when the payload does not carry it.
 */
function readSourceTypeFromWebhookResource(resource) {
  const attrs = resource?.attributes || {};
  const fromPayment = attrs.source?.type || attrs.payment_method_used || null;
  if (fromPayment) return String(fromPayment).toLowerCase();

  const payments = Array.isArray(attrs.payments) ? attrs.payments : [];
  const paid = payments.find((p) => (p?.attributes?.status || p?.status) === 'paid') || payments[0] || null;
  const fromSession = paid?.attributes?.source?.type || paid?.attributes?.payment_method_used || null;
  return fromSession ? String(fromSession).toLowerCase() : null;
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
  sanitizeOnlineMethods,
  ALLOWED_ONLINE_METHODS,
  retrieveCheckoutSession,
  readSessionOutcome,
  readSourceTypeFromWebhookResource,
  verifyWebhookSignature,
  toCentavos,
};
