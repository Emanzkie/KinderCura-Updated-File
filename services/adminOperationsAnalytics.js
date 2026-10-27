// services/adminOperationsAnalytics.js
//
// Pure, DB-free helpers behind GET /api/admin/analytics/operations
// (routes/admin.js): the Admin Analytics figures about accounts, clinic
// payments and the reporting period. READ-ONLY — nothing here writes, and no
// clinical field (scores, bands, diagnoses, outcomes) is read or returned.
//
// ── Payment status groups ──────────────────────────────────────────────────
// Identical to the grouping the Admin Payments monitor already uses
// (controllers/paymentController.js getAdminPaymentMonitor), so the two admin
// pages can never disagree about what "collected" means:
//   collected  'Paid', 'Down Payment', 'Partially Paid'
//              (only these amounts are money received — a down or partial
//              payment record holds the amount actually paid in that
//              transaction, see services/paymentService.js)
//   pending    'Pending', 'Verification Pending'
//   failed     'Failed', 'Expired'
//   refunded   'Refunded'
// Every other stored status (e.g. 'Cancelled') is listed under "other" by its
// own name and never added to the collected total.

const PAYMENT_STATUS_GROUPS = Object.freeze([
  Object.freeze({ key: 'collected', label: 'Collected (paid in full or in part)', statuses: Object.freeze(['Paid', 'Down Payment', 'Partially Paid']) }),
  Object.freeze({ key: 'pending', label: 'Pending', statuses: Object.freeze(['Pending', 'Verification Pending']) }),
  Object.freeze({ key: 'failed', label: 'Failed or expired', statuses: Object.freeze(['Failed', 'Expired']) }),
  Object.freeze({ key: 'refunded', label: 'Refunded', statuses: Object.freeze(['Refunded']) }),
]);

function paymentGroupFor(status) {
  const g = PAYMENT_STATUS_GROUPS.find((x) => x.statuses.includes(status));
  return g ? g.key : 'other';
}

const { DATE_ONLY, CLINIC_TIMEZONE, clinicDayStart, clinicDayEnd } = require('../constants/clinicTime');

/**
 * Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD, as whole clinic (Manila) days —
 * also the day boundaries of the Admin Payments monitor's date filter.
 * Absent = all time. Returns { from, to } as Dates or null, or { error }.
 */
function parsePeriod(query) {
  const q = query || {};
  const rawFrom = q.from == null ? '' : String(q.from).trim();
  const rawTo = q.to == null ? '' : String(q.to).trim();
  const out = { from: null, to: null };
  if (rawFrom) {
    if (!DATE_ONLY.test(rawFrom)) return { error: '`from` must be a date in YYYY-MM-DD format.' };
    out.from = clinicDayStart(rawFrom);
    if (Number.isNaN(out.from.getTime())) return { error: '`from` is not a valid date.' };
  }
  if (rawTo) {
    if (!DATE_ONLY.test(rawTo)) return { error: '`to` must be a date in YYYY-MM-DD format.' };
    out.to = clinicDayEnd(rawTo);
    if (Number.isNaN(out.to.getTime())) return { error: '`to` is not a valid date.' };
  }
  if (out.from && out.to && out.from > out.to) return { error: '`from` must not be later than `to`.' };
  return out;
}

/** Mongo filter on one date field for a parsed period; {} for all time. */
function periodMatch(field, period) {
  if (!period || (!period.from && !period.to)) return {};
  const range = {};
  if (period.from) range.$gte = period.from;
  if (period.to) range.$lte = period.to;
  return { [field]: range };
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * rows: [{ _id: { status, currency }, count, amount }] from one $group over
 * Payment. Returns per-group and per-status counts and amounts. Counts and
 * amounts are kept as separate measures; only the 'collected' group's amount
 * is money received.
 */
function summarizePayments(rows) {
  const byStatus = new Map();
  const currencies = new Set();
  let missingCurrency = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const status = r._id && r._id.status != null ? String(r._id.status) : 'No status';
    const currency = r._id && r._id.currency ? String(r._id.currency) : null;
    if (currency) currencies.add(currency); else missingCurrency += r.count || 0;
    const prev = byStatus.get(status) || { status, group: paymentGroupFor(status), count: 0, amount: 0 };
    prev.count += r.count || 0;
    prev.amount += Number(r.amount || 0);
    byStatus.set(status, prev);
  }
  const statuses = Array.from(byStatus.values())
    .map((s) => ({ ...s, amount: round2(s.amount) }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));

  const groups = [...PAYMENT_STATUS_GROUPS.map((g) => ({ key: g.key, label: g.label, statuses: g.statuses.slice() })),
    { key: 'other', label: 'Other recorded statuses', statuses: [] }]
    .map((g) => {
      const members = statuses.filter((s) => s.group === g.key);
      return {
        key: g.key,
        label: g.label,
        statuses: g.key === 'other' ? members.map((m) => m.status) : g.statuses,
        count: members.reduce((n, m) => n + m.count, 0),
        amount: round2(members.reduce((n, m) => n + m.amount, 0)),
      };
    });

  return {
    totalCount: statuses.reduce((n, s) => n + s.count, 0),
    groups,
    statuses,
    currencies: Array.from(currencies).sort(),
    recordsWithoutCurrency: missingCurrency,
  };
}

/**
 * rows: [{ _id: { key, synthetic }, count }] — counts per key (role, status,
 * PRC status) split into real and synthetic (isSynthetic: true) records.
 */
function splitBySynthetic(rows) {
  const map = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = r._id && r._id.key != null ? String(r._id.key) : null;
    const k = key == null ? '__none' : key;
    const prev = map.get(k) || { key, real: 0, synthetic: 0, total: 0 };
    if (r._id && r._id.synthetic) prev.synthetic += r.count || 0; else prev.real += r.count || 0;
    prev.total = prev.real + prev.synthetic;
    map.set(k, prev);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total || String(a.key).localeCompare(String(b.key)));
}

/**
 * New user accounts per calendar month (clinic time) of createdAt, with how
 * many of them are synthetic demo accounts. One definition, shared by GET
 * /analytics and GET /analytics/operations so the two can never report
 * different months.
 */
function monthlySignupsPipeline() {
  return [
    {
      $group: {
        _id: {
          year: { $year: { date: '$createdAt', timezone: CLINIC_TIMEZONE } },
          month: { $month: { date: '$createdAt', timezone: CLINIC_TIMEZONE } },
        },
        count: { $sum: 1 },
        // How many of `count` are synthetic demo accounts (isSynthetic: true).
        syntheticCount: { $sum: { $cond: [{ $eq: ['$isSynthetic', true] }, 1, 0] } },
      },
    },
    { $sort: { '_id.year': -1, '_id.month': -1 } },
  ];
}

/**
 * The last six calendar months, oldest first, ending with the current
 * (in-progress) month; a month with no accounts is 0. rows come from
 * monthlySignupsPipeline().
 */
function buildMonthlySignups(rows, now) {
  const monthlyMap = {};
  const monthlySyntheticMap = {};
  (Array.isArray(rows) ? rows : []).forEach((m) => {
    monthlyMap[`${m._id.year}-${String(m._id.month).padStart(2, '0')}`] = m.count;
    monthlySyntheticMap[`${m._id.year}-${String(m._id.month).padStart(2, '0')}`] = m.syntheticCount || 0;
  });
  // The current month is the clinic's, not the server's (UTC on Vercel).
  const [year, month] = new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TIMEZONE, year: 'numeric', month: '2-digit' })
    .format(now).split('-').map(Number);
  const monthlySignups = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthlySignups.push({
      month: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      count: monthlyMap[key] || 0,
      syntheticCount: monthlySyntheticMap[key] || 0,
    });
  }
  return monthlySignups;
}

module.exports = {
  monthlySignupsPipeline,
  buildMonthlySignups,
  PAYMENT_STATUS_GROUPS,
  paymentGroupFor,
  parsePeriod,
  periodMatch,
  summarizePayments,
  splitBySynthetic,
};
