// constants/legalConsent.js
// Sign-up consent rules.
//
// The WORDING of the three selections (Terms acceptance, Privacy Notice
// acknowledgment, optional machine-learning consent) lives only in
// SIGN-UP,LOGIN/legal/KINDERCURA-TERMS-OF-SERVICE.txt, section 17. Nothing in
// this file restates or paraphrases it: this module only decides whether the two
// REQUIRED selections were made and shapes the record stored on User.consents.
//
// Machine-learning consent is deliberately independent: it never affects
// whether registration is allowed.

// Must equal the "Version:" line of the Terms file — asserted in
// tests/unit/signup-consent.test.js so the two cannot drift apart silently.
const TERMS_VERSION = '1.0';

// Registration arrives either as JSON (booleans) or as multipart form fields
// (strings), so both forms are accepted. Anything else counts as "not selected".
function isAffirmative(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['true', 'on', '1'].includes(value.trim().toLowerCase());
}

function parseSignupConsent(body, now = new Date()) {
  const src = body || {};
  const acceptTerms = isAffirmative(src.acceptTerms);
  const acknowledgePrivacy = isAffirmative(src.acknowledgePrivacy);

  if (!acceptTerms && !acknowledgePrivacy) {
    return { ok: false, error: 'You must accept the Terms of Service and acknowledge the Privacy Notice to create an account.' };
  }
  if (!acceptTerms) {
    return { ok: false, error: 'You must accept the Terms of Service to create an account.' };
  }
  if (!acknowledgePrivacy) {
    return { ok: false, error: 'You must acknowledge the Privacy Notice to create an account.' };
  }

  return {
    ok: true,
    consents: {
      termsVersion: TERMS_VERSION,
      termsAcceptedAt: now,
      privacyNoticeAcknowledgedAt: now,
      // true = opted in, false = asked and declined. (null on the User means "never asked".)
      mlConsentGiven: isAffirmative(src.mlConsent),
      mlConsentRecordedAt: now,
    },
  };
}

module.exports = { TERMS_VERSION, isAffirmative, parseSignupConsent };
