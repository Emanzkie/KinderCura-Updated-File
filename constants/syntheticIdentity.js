// constants/syntheticIdentity.js
// ============================================================================
// Realistic, deterministic identities for synthetic KinderCura accounts.
//
// WHY THIS EXISTS
// ---------------
// The first generation of demo accounts was correct but unmistakably fake:
// `kc_demo_00001` / `kc_demo_00001@synthetic.kindercura.test`, and names drawn
// from a 30x30 pool that repeated heavily across 1,500 users. That is fine for
// a correctness test and wrong for a demo — a reviewer looking at the admin
// Users page should see something shaped like real KinderCura data.
//
// This module is the SINGLE source of those identities, shared by
// scripts/generate-system-demo-data.js (new batches) and
// scripts/improve-synthetic-user-profiles.js (existing rows). Keeping one
// implementation is what stops a later regeneration from silently reverting an
// improved batch back to kc_demo_00001.
//
// WHAT IT IS NOT
// --------------
// Making an account LOOK real must never make it BE real, or make it
// impersonable. Three rules hold that line:
//
//   1. The email domain is `kindercura.test`. `.test` is reserved by RFC 2606
//      and can never resolve in the public DNS, so no address generated here
//      can reach a mailbox — it cannot collide with a real person's inbox, and
//      it cannot be used to receive mail. Real user addresses live on real
//      domains (gmail.com etc.), so the two sets can never intersect.
//   2. Phone numbers use the `555` fictional-subscriber convention inside a
//      real-looking Philippine mobile prefix: 0917-555-XXXX. The format is
//      plausible; the 555 block signals fiction. This is deliberately NOT a
//      fully random 09XXXXXXXXX, which is what the previous generation used
//      and which can land on a live subscriber number.
//   3. Nothing here touches isSynthetic / syntheticBatch. A prettier record is
//      still a synthetic record, and the markers that make it purgeable and
//      excludable are untouched.
//
// DETERMINISM
// -----------
// buildSyntheticIdentities(batch, count) is a pure function: the same (batch,
// count) always yields the same array, including the collision suffixes. That
// is what lets the improvement script be re-run safely and lets a regenerated
// batch match an improved one exactly.
// ============================================================================

const crypto = require('crypto');

// RFC 2606 reserved TLD — unresolvable by design. See rule 1 above.
const SYNTHETIC_EMAIL_DOMAIN = 'kindercura.test';

// The address pattern the FIRST generation used. Retained so isSyntheticEmail()
// still recognises accounts that have not been through the improvement script.
const LEGACY_SYNTHETIC_EMAIL_DOMAIN = 'synthetic.kindercura.test';

// Philippine mobile prefixes that read as real carrier ranges, paired with the
// 555 fictional-subscriber block. Varied so 1,500 accounts do not all share one
// prefix, which would look generated.
const PH_MOBILE_PREFIXES = ['0917', '0918', '0919', '0920', '0921', '0927', '0928', '0929', '0935', '0936', '0939', '0945', '0947', '0949', '0956', '0965', '0966', '0977', '0995', '0997', '0998', '0999'];
const FICTIONAL_SUBSCRIBER_BLOCK = '555';

// ── Name pools ──────────────────────────────────────────────────────────────
// Ordinary Philippine given and family names. Sized so the combination space
// (>10,000) comfortably exceeds any batch we generate, which is what keeps
// repetition down — the previous 30x30 pool guaranteed collisions at 1,500.
const FIRST_NAMES_F = [
  'Maria', 'Andrea', 'Sofia', 'Bianca', 'Camille', 'Danica', 'Elaine', 'Fatima', 'Grace', 'Hannah',
  'Isabel', 'Jasmine', 'Kristine', 'Lorna', 'Michelle', 'Nadine', 'Olivia', 'Patricia', 'Rowena', 'Sarah',
  'Trisha', 'Vanessa', 'Wilma', 'Yolanda', 'Zenaida', 'Angelica', 'Beatriz', 'Carmela', 'Divina', 'Erika',
  'Faye', 'Gemma', 'Hazel', 'Imelda', 'Jocelyn', 'Katrina', 'Liezl', 'Mariel', 'Nicole', 'Odette',
  'Precious', 'Rachelle', 'Sheila', 'Teresa', 'Ursula', 'Veronica', 'Wendy', 'Ximena', 'Yvonne', 'Zaira',
  'Althea', 'Bernadette', 'Clarisse', 'Dianne', 'Evelyn', 'Francine', 'Gabrielle', 'Heidi', 'Ivy', 'Janine',
  'Kaye', 'Lourdes', 'Monica', 'Nerissa', 'Pamela', 'Queenie', 'Rosalie', 'Stephanie', 'Tricia', 'Valerie',
];
const FIRST_NAMES_M = [
  'Jose', 'Antonio', 'Carlo', 'Daniel', 'Emilio', 'Francis', 'Gabriel', 'Hector', 'Ignacio', 'Julius',
  'Kevin', 'Lorenzo', 'Marco', 'Nathan', 'Oscar', 'Paulo', 'Rafael', 'Samuel', 'Teodoro', 'Ulysses',
  'Vicente', 'Wilfredo', 'Xavier', 'Zacarias', 'Alfonso', 'Benigno', 'Cristian', 'Dominic', 'Enrique', 'Fernando',
  'Gerardo', 'Hermes', 'Isagani', 'Joshua', 'Karl', 'Leandro', 'Manuel', 'Noel', 'Orlando', 'Patricio',
  'Quintin', 'Ramon', 'Sergio', 'Tomas', 'Urbano', 'Victor', 'Warren', 'Yuri', 'Zaldy', 'Adrian',
  'Bryan', 'Cesar', 'Diego', 'Eduardo', 'Fidel', 'Gilbert', 'Harold', 'Ismael', 'Jerome', 'Kristoffer',
  'Lito', 'Mateo', 'Nestor', 'Onofre', 'Pedro', 'Reynaldo', 'Simon', 'Tirso', 'Vladimir', 'Wilson',
];
const LAST_NAMES = [
  'Santos', 'Reyes', 'Cruz', 'Bautista', 'Ocampo', 'Garcia', 'Mendoza', 'Torres', 'Tomas', 'Andrada',
  'Castillo', 'Flores', 'Villanueva', 'Ramos', 'Aquino', 'Del Rosario', 'Gonzales', 'Fernandez', 'Rivera', 'Navarro',
  'Domingo', 'Salazar', 'Alvarez', 'Pascual', 'Marquez', 'Ibarra', 'Lucero', 'Espiritu', 'Manalo', 'Sarmiento',
  'Abad', 'Bagtas', 'Cabrera', 'Dizon', 'Enriquez', 'Fajardo', 'Galang', 'Hernandez', 'Ilagan', 'Jimenez',
  'Katigbak', 'Lagman', 'Macaraeg', 'Nicolas', 'Obispo', 'Padilla', 'Quiambao', 'Rosales', 'Soriano', 'Tolentino',
  'Uy', 'Valdez', 'Wenceslao', 'Yabut', 'Zamora', 'Agustin', 'Buenaventura', 'Corpuz', 'Dela Cruz', 'Escobar',
  'Feliciano', 'Guevarra', 'Hizon', 'Inocencio', 'Javier', 'Lazaro', 'Magbanua', 'Nuñez', 'Ordonez', 'Pineda',
  'Rivas', 'Serrano', 'Trinidad', 'Vergara', 'Yambao', 'Zulueta', 'Bernardo', 'Calderon', 'Duran', 'Estrada',
  'Fuentes', 'Gutierrez', 'Herrera', 'Legaspi', 'Montemayor', 'Olivar', 'Perez', 'Roxas', 'Sandoval', 'Villamor',
];

// Short professional bios for synthetic pediatricians. These REPLACE the
// previous literal "Synthetic demo pediatrician account for KinderCura
// analytics testing." — dummy text sitting in a field parents can read. They
// describe a practice in ordinary terms and claim no credential the account
// does not already carry in its structured fields.
const PEDIATRICIAN_BIOS = [
  'General pediatric practice with an interest in early childhood development and routine well-child care.',
  'Focused on developmental screening and follow-up for preschool and early school-age children.',
  'Community-based pediatrician; regular clinic hours for check-ups, immunisation and growth monitoring.',
  'Works with families on early developmental concerns, referrals and follow-up scheduling.',
  'Clinic practice covering well-child visits, developmental checks and parent guidance.',
  'Sees children from toddler through early school age, with a focus on developmental milestones.',
  'Routine paediatric consultations, growth tracking and developmental follow-up.',
  'Practice centred on preventive care, developmental screening and family counselling.',
];

// ── Deterministic randomness ────────────────────────────────────────────────
// mulberry32 seeded from a hash of (batch, purpose, index), so every value is a
// pure function of the account's identity — no Math.random anywhere.
function seedFrom(batch, purpose, index) {
  const digest = crypto.createHash('sha1').update(`kindercura-identity:${batch}:${purpose}:${index}`).digest();
  return digest.readUInt32BE(0);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lowercase ASCII slug suitable for the local part of an address / a username. */
function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics: Nuñez -> Nunez
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')        // 'Del Rosario' -> 'delrosario'
    .trim();
}

/**
 * Deterministic Philippine-style mobile number for one account.
 * See rule 2 in the header: real-looking prefix, fictional 555 block.
 */
function syntheticPhoneNumber(batch, index) {
  const rng = mulberry32(seedFrom(batch, 'phone', index));
  const prefix = PH_MOBILE_PREFIXES[Math.floor(rng() * PH_MOBILE_PREFIXES.length)];
  const subscriber = String(Math.floor(rng() * 10000)).padStart(4, '0');
  return `${prefix}${FICTIONAL_SUBSCRIBER_BLOCK}${subscriber}`;
}

/** Deterministic professional bio, or null — real pediatricians often leave it blank. */
function syntheticPediatricianBio(batch, index) {
  const rng = mulberry32(seedFrom(batch, 'bio', index));
  if (rng() < 0.35) return null; // matches the real record, which has no bio
  return PEDIATRICIAN_BIOS[Math.floor(rng() * PEDIATRICIAN_BIOS.length)];
}

/**
 * Build `count` unique, realistic identities for a batch.
 *
 * Uniqueness is resolved in a single deterministic pass: `username` is
 * first.last, with the smallest free numeric suffix appended only when that
 * exact pairing has already been taken. Because username is unique, the email
 * built from it is unique too — which matters, because BOTH carry unique
 * indexes and a collision would abort a bulk write halfway through.
 *
 * @param {string} batch  batch label, e.g. 'demo-2026'
 * @param {number} count  how many identities to build
 * @returns {Array<{firstName,lastName,username,email,phoneNumber}>}
 */
function buildSyntheticIdentities(batch, count) {
  if (!batch || typeof batch !== 'string') throw new Error('buildSyntheticIdentities(batch, count) requires a batch label.');

  const identities = [];
  const usedUsernames = new Set();

  for (let i = 0; i < count; i += 1) {
    const rng = mulberry32(seedFrom(batch, 'name', i));
    const isFemale = rng() < 0.55;
    const pool = isFemale ? FIRST_NAMES_F : FIRST_NAMES_M;
    const firstName = pool[Math.floor(rng() * pool.length)];
    const lastName = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];

    const base = `${slugify(firstName)}.${slugify(lastName)}`;
    let username = base;
    let suffix = 2;
    while (usedUsernames.has(username)) {
      username = `${base}${suffix}`;
      suffix += 1;
    }
    usedUsernames.add(username);

    // A plain first.last address looks generated at volume, so an unsuffixed
    // username gets a natural two-digit tail. A username that ALREADY carries a
    // collision suffix does not get a second number stacked on it.
    const emailLocal = username === base
      ? `${base}${10 + Math.floor(rng() * 90)}`
      : username;

    identities.push({
      firstName,
      lastName,
      username,
      email: `${emailLocal}@${SYNTHETIC_EMAIL_DOMAIN}`,
      phoneNumber: syntheticPhoneNumber(batch, i),
    });
  }

  return identities;
}

/** True when an address belongs to either synthetic namespace (current or legacy). */
function isSyntheticEmailAddress(email) {
  const lower = String(email || '').toLowerCase();
  return lower.endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`) || lower.endsWith(`@${LEGACY_SYNTHETIC_EMAIL_DOMAIN}`);
}

module.exports = {
  SYNTHETIC_EMAIL_DOMAIN,
  LEGACY_SYNTHETIC_EMAIL_DOMAIN,
  PH_MOBILE_PREFIXES,
  FICTIONAL_SUBSCRIBER_BLOCK,
  FIRST_NAMES_F,
  FIRST_NAMES_M,
  LAST_NAMES,
  PEDIATRICIAN_BIOS,
  buildSyntheticIdentities,
  syntheticPhoneNumber,
  syntheticPediatricianBio,
  isSyntheticEmailAddress,
  slugify,
};
