// constants/assessmentDomains.js
// Single source of truth for the four OFFICIAL assessment scoring domains and
// how a pediatrician's Custom Question domain maps onto them.
//
// Why this exists: routes/assessments.js scores each screening into exactly
// four buckets (see the `totals` object in POST /submit, and the enum on
// models/Assessment.js:58 clinicalOutcomeDomains). The Custom Question feature
// (models/PediaCustomQuestion.js) used to let pediatricians pick from a
// DIFFERENT, older domain vocabulary — Gross Motor / Fine Motor / Language /
// Personal-Social / Other — left over from before Custom Questions could be
// folded into a reassessment's score. None of those strings matched the
// `totals` keys, so a custom question's domain could never actually
// contribute to a domain score; it silently fell through the
// `domainIsScored` check in routes/assessments.js POST /submit.
//
// This module is the ONLY place that vocabulary is defined. Both the
// pediatrician-facing dropdown (PEDIA/pedia-questions.html) and every server
// read/write path funnel through here so they can never drift apart again.

// Exactly the four domains Assessment / AssessmentResult / scoring already
// use. Order matches models/Assessment.js:58 and routes/assessments.js totals.
const ASSESSMENT_DOMAINS = Object.freeze(['Communication', 'Social Skills', 'Cognitive', 'Motor Skills']);

// Old Custom-Question-only domain labels, mapped onto the official domain
// they conceptually belong to. Anything not listed here (including the old
// 'Other' catch-all, and any junk/blank value) falls back to
// FALLBACK_DOMAIN below rather than being rejected — see normalizeDomain().
const LEGACY_DOMAIN_MAP = Object.freeze({
  'Gross Motor': 'Motor Skills',
  'Fine Motor': 'Motor Skills',
  'Language': 'Communication',
  'Personal-Social': 'Social Skills',
});

// Where an unrecognized/legacy value lands when it has no direct mapping
// above (this is only 'Other' in practice, plus any corrupt/blank data).
// Cognitive is the one official domain that had no equivalent option in the
// old dropdown at all, which makes it the natural catch-all for questions
// that were previously bucketed as "doesn't fit motor/language/social".
const FALLBACK_DOMAIN = 'Cognitive';

/**
 * Normalize any stored/incoming domain value (official, legacy, or garbage)
 * to one of the four ASSESSMENT_DOMAINS. Never returns anything else — this
 * is what guarantees a Custom Question's domain always lines up with an
 * existing Assessment/AssessmentResult scoring bucket.
 */
function normalizeDomain(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (ASSESSMENT_DOMAINS.includes(trimmed)) return trimmed;
  if (LEGACY_DOMAIN_MAP[trimmed]) return LEGACY_DOMAIN_MAP[trimmed];
  return FALLBACK_DOMAIN;
}

// Strict check for NEW question creation/edits: only an exact official
// domain is accepted (no legacy aliases) — the dropdown only ever offers
// these four, so anything else at this point is a malformed request.
function isValidNewDomain(value) {
  return ASSESSMENT_DOMAINS.includes(value);
}

module.exports = {
  ASSESSMENT_DOMAINS,
  LEGACY_DOMAIN_MAP,
  FALLBACK_DOMAIN,
  normalizeDomain,
  isValidNewDomain,
};
