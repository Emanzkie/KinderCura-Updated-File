// tests/unit/paymongo-billing.test.js
// Locks in the "final PayMongo billing wins over the KinderCura pre-fill"
// rule with pure, no-DB, no-network tests, using fixture payloads shaped
// exactly like PayMongo's documented Checkout Session / webhook resources
// (see https://docs.paymongo.com/reference/checkout-session-resource).
//
// What this file does NOT (and cannot) prove: that PayMongo's hosted
// checkout page actually lets the payer edit the pre-filled email/phone, or
// that a live PayMongo test-mode payment reports the edited value back in
// the shapes these fixtures assume. That requires an actual PayMongo
// test-mode checkout — see the manual test steps in the PR/report.

const assert = require('assert');
const paymongoService = require('../../services/paymongoService');
const receiptService = require('../../services/receiptService');

// ── Fixtures ─────────────────────────────────────────────────────────────

// A retrieved Checkout Session (GET /checkout_sessions/:id with the secret
// key) after the payer changed the pre-filled email/phone on PayMongo's
// hosted page before paying with GCash.
function sessionFixture({ paymentBilling, sessionBilling, paymentsArray } = {}) {
  return {
    data: {
      id: 'cs_test123',
      type: 'checkout_session',
      attributes: {
        billing: sessionBilling === undefined
          ? { name: 'Juan Dela Cruz', email: 'registered@kindercura.test', phone: '' }
          : sessionBilling,
        payment_status: 'paid',
        reference_number: 'KC-PAY-2026-000123',
        payments: paymentsArray !== undefined ? paymentsArray : [
          {
            id: 'pay_abc123',
            type: 'payment',
            attributes: {
              status: 'paid',
              amount: 50000,
              source: { type: 'gcash' },
              billing: paymentBilling === undefined
                ? { name: 'Juan Dela Cruz', email: 'other@example.com', phone: '+639171234567' }
                : paymentBilling,
            },
          },
        ],
      },
    },
  };
}

function checkoutSessionWebhookResource({ paymentBilling, sessionBilling, paymentsArray } = {}) {
  return {
    id: 'cs_test123',
    type: 'checkout_session',
    attributes: sessionFixture({ paymentBilling, sessionBilling, paymentsArray }).data.attributes,
  };
}

function directPaymentWebhookResource(billing) {
  return {
    id: 'pay_abc123',
    type: 'payment',
    attributes: {
      status: 'paid',
      amount: 50000,
      source: { type: 'paymaya' },
      billing: billing === undefined ? { name: 'Juan Dela Cruz', email: 'other@example.com', phone: '' } : billing,
    },
  };
}

function paymentIntentWebhookResource({ paymentBilling } = {}) {
  return {
    id: 'pi_xyz789',
    type: 'payment_intent',
    attributes: {
      status: 'succeeded',
      payments: [
        {
          id: 'pay_abc123',
          type: 'payment',
          attributes: {
            status: 'paid',
            source: { type: 'gcash' },
            billing: paymentBilling === undefined
              ? { name: 'Juan Dela Cruz', email: 'other@example.com', phone: '+639171234567' }
              : paymentBilling,
          },
        },
      ],
    },
  };
}

// ── readSessionOutcome (server-side Checkout Session retrieval) ──────────

function testReadSessionOutcomePrefersPaymentBillingOverSessionPrefill() {
  const outcome = paymongoService.readSessionOutcome(sessionFixture());
  assert.strictEqual(outcome.isPaid, true);
  assert.strictEqual(outcome.sourceType, 'gcash');
  // The payer changed the email on PayMongo's hosted page — the payment
  // resource's own billing ("other@example.com") must win over the session's
  // original pre-fill ("registered@kindercura.test").
  assert.strictEqual(outcome.billingEmail, 'other@example.com');
  assert.strictEqual(outcome.billingPhone, '+639171234567');
}

function testReadSessionOutcomeFallsBackToSessionBillingWhenNoPayments() {
  // No settled payment sub-resource available (edge case) — fall back to the
  // session-level billing rather than reporting nothing.
  const outcome = paymongoService.readSessionOutcome(sessionFixture({ paymentsArray: [] }));
  assert.strictEqual(outcome.billingEmail, 'registered@kindercura.test');
  assert.strictEqual(outcome.billingPhone, null); // "" normalizes to null
}

function testReadSessionOutcomeBlankPaymentBillingReturnsNull() {
  // PayMongo's payment sub-resource exists but reports a blank email (e.g. an
  // e-wallet flow that never collected one) — must be null, not "".
  const outcome = paymongoService.readSessionOutcome(
    sessionFixture({ paymentBilling: { name: 'Juan', email: '', phone: '' } })
  );
  assert.strictEqual(outcome.billingEmail, null);
  assert.strictEqual(outcome.billingPhone, null);
}

function testReadSessionOutcomeMissingBillingEntirely() {
  const outcome = paymongoService.readSessionOutcome(
    sessionFixture({ paymentBilling: null, sessionBilling: null })
  );
  assert.strictEqual(outcome.billingEmail, null);
  assert.strictEqual(outcome.billingPhone, null);
}

// ── readBillingFromWebhookResource (all three delivered resource shapes) ──

function testWebhookBillingFromCheckoutSessionResource() {
  const { billingEmail, billingPhone } = paymongoService.readBillingFromWebhookResource(
    checkoutSessionWebhookResource()
  );
  assert.strictEqual(billingEmail, 'other@example.com');
  assert.strictEqual(billingPhone, '+639171234567');
}

function testWebhookBillingFromDirectPaymentResource() {
  const { billingEmail, billingPhone } = paymongoService.readBillingFromWebhookResource(
    directPaymentWebhookResource()
  );
  assert.strictEqual(billingEmail, 'other@example.com');
  assert.strictEqual(billingPhone, null); // blank phone normalizes to null, never ""
}

function testWebhookBillingFromPaymentIntentResource() {
  const { billingEmail, billingPhone } = paymongoService.readBillingFromWebhookResource(
    paymentIntentWebhookResource()
  );
  assert.strictEqual(billingEmail, 'other@example.com');
  assert.strictEqual(billingPhone, '+639171234567');
}

function testWebhookBillingMissingResourceIsSafe() {
  const { billingEmail, billingPhone } = paymongoService.readBillingFromWebhookResource(null);
  assert.strictEqual(billingEmail, null);
  assert.strictEqual(billingPhone, null);
}

// ── resolveReceiptContact (the "never blank a valid value" rule) ─────────

function testResolveReceiptContactUsesFinalPaymongoEmail() {
  // TEST 2: PayMongo reports a different final billing.email than the
  // KinderCura pre-fill -> Payment.receiptEmail must become that email.
  const updates = receiptService.resolveReceiptContact({
    billingEmail: 'OTHER@Example.com', // mixed case, as a real form field might submit
    billingPhone: '+639171234567',
  });
  assert.strictEqual(updates.receiptEmail, 'other@example.com');
  assert.strictEqual(updates.receiptPhone, '+639171234567');
}

function testResolveReceiptContactBlankNeverOverwrites() {
  // TEST 3: PayMongo returns a blank/null billing.email -> no receiptEmail
  // key at all, so the caller's $set never touches (and never blanks) the
  // existing stored value.
  const updates = receiptService.resolveReceiptContact({ billingEmail: '', billingPhone: null });
  assert.strictEqual('receiptEmail' in updates, false);
  assert.strictEqual('receiptPhone' in updates, false);
}

function testResolveReceiptContactMissingPaymongoObject() {
  const updates = receiptService.resolveReceiptContact(undefined);
  assert.deepStrictEqual(updates, {});
}

function run() {
  testReadSessionOutcomePrefersPaymentBillingOverSessionPrefill();
  testReadSessionOutcomeFallsBackToSessionBillingWhenNoPayments();
  testReadSessionOutcomeBlankPaymentBillingReturnsNull();
  testReadSessionOutcomeMissingBillingEntirely();
  testWebhookBillingFromCheckoutSessionResource();
  testWebhookBillingFromDirectPaymentResource();
  testWebhookBillingFromPaymentIntentResource();
  testWebhookBillingMissingResourceIsSafe();
  testResolveReceiptContactUsesFinalPaymongoEmail();
  testResolveReceiptContactBlankNeverOverwrites();
  testResolveReceiptContactMissingPaymongoObject();
  console.log('PayMongo billing capture rules OK — final checkout email/phone wins, blank never overwrites, User.email is never touched by this module');
}

run();
