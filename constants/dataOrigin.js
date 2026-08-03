// constants/dataOrigin.js
// Purpose:
// - Single source of truth for how a screening question entered the system.
//
// Important: the distinction below is MECHANISM, not authorship. Both origins
// trace back to doctors — the core bank was transcribed from our consultant
// pediatrician's interview (see js/parent/screening.js:4). What separates them
// is how the question gets into the system and who can change it:
//
//   CORE_BANK   → fixed system-wide baseline. No pediatricianId, identical for
//                 every child and every clinic, changeable only by code deploy.
//   PEDIA_ENTRY → created at runtime by an authenticated pediatrician. Has a
//                 pediatricianId and createdAt, scoped to specific children.
//
// Do NOT call the core bank a "dataset". The datasets in this project are
// ml/test_dataset.csv and the CSVs in the TrainingDataset collection —
// aggregate scores with risk_category used for ML training. That is a separate
// concern from question provenance, reserved below as ML_DATASET.
//
// Important: origin is always decided on the server. Never read it from
// req.body, otherwise a client could label its own answers as core-bank content.

const DATA_ORIGIN = Object.freeze({
  CORE_BANK: 'core_bank',
  PEDIA_ENTRY: 'pedia_entry',
});

// Reserved for a future extension to the ML module (training CSVs).
// Deliberately NOT in DATA_ORIGIN_VALUES yet, so the schema enums reject it
// until we actually implement it — a typo can't silently create a third bucket.
const RESERVED_ORIGIN = Object.freeze({
  ML_DATASET: 'ml_dataset',
});

// Shared by every schema enum so the allowed values can never drift apart.
const DATA_ORIGIN_VALUES = Object.freeze([DATA_ORIGIN.CORE_BANK, DATA_ORIGIN.PEDIA_ENTRY]);

// Human labels for the admin UI and report exports.
//
// Important: "Core Question Bank", never "Standard" anything. "Standard"
// implies a validated instrument (ASQ, DDST, M-CHAT) and we cannot claim that —
// the same overclaim that made us drop the word "dataset". One word carries
// from enum to screen: core_bank → CoreBankQuestion → core_bank_questions →
// "Core Question Bank".
const DATA_ORIGIN_LABELS = Object.freeze({
  [DATA_ORIGIN.CORE_BANK]: 'Core Question Bank',
  [DATA_ORIGIN.PEDIA_ENTRY]: 'Pediatrician Entry',
});

function isValidOrigin(value) {
  return DATA_ORIGIN_VALUES.includes(value);
}

function originLabel(value) {
  return DATA_ORIGIN_LABELS[value] || 'Unknown';
}

module.exports = {
  DATA_ORIGIN,
  DATA_ORIGIN_VALUES,
  DATA_ORIGIN_LABELS,
  RESERVED_ORIGIN,
  isValidOrigin,
  originLabel,
  // Convenience named exports so callers can destructure directly.
  CORE_BANK: DATA_ORIGIN.CORE_BANK,
  PEDIA_ENTRY: DATA_ORIGIN.PEDIA_ENTRY,
};
