// Builds the pediatrician review packet.
// READ-ONLY over the catalog: question text, domain, age, source, citation
// and verbatim source item are all read from constants/datasetQuestions.js so
// no wording can drift between the code and the packet. The review commentary
// below is the only hand-written part.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Default into build/ (gitignored) so `npm run packet:dataset-questions` works
// with no argument and never commits a generated artifact. Pass an explicit
// path as argv[2] to write elsewhere.
const OUT = process.argv[2] || path.join(ROOT, 'build', 'dataset-question-review-packet.html');

const {
  DATASET_QUESTIONS,
  DATASET_SOURCES,
  DATASET_REVIEW,
} = require(path.join(ROOT, 'constants/datasetQuestions.js'));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Hand-written review commentary, keyed by question id.
//   whyValid   — the argument that the mapping holds
//   difference — where our wording departs from the source (always stated,
//                even when minor; "none" is itself a finding)
//   ruling     — present ONLY on the four items where a judgment was taken
//                on 2026-08-28. A ruling is a REVIEWER RECOMMENDATION and is
//                not a pediatrician sign-off.
const NOTES = {
  DQ01: {
    whyValid: 'The source item and our question ask about the same observable behavior: the child spontaneously reporting an event from earlier in the day. Nothing is added or removed from the underlying skill.',
    difference: 'Our examples (school, playtime) replace the source example ("I played soccer"), which is US-specific. The skill being asked about is unchanged.',
  },
  DQ02: {
    whyValid: 'Both ask whether the child can state the function of a familiar everyday object on request. The source gives the construct as a question-and-answer exchange, which is exactly how we ask it.',
    difference: 'Our objects (spoon, umbrella) differ from the source objects (coat, crayon). Chosen as more universally familiar; the cognitive demand is equivalent.',
  },
  DQ03: {
    whyValid: 'The source item covers both recognizing and producing rhymes, and our question asks about both. Rhyme awareness is the construct on either side.',
    difference: 'Both source examples (bat-cat, ball-tall) are dropped rather than replaced, because a rhyme pair only works in the language it was written for. "In any language your child speaks" is ours; the source assumes a single-language setting.',
  },
  DQ04: {
    whyValid: 'The source construct is sustaining a conversation across multiple turns rather than a single reply. Our wording describes the same thing in terms a parent can observe without counting.',
    difference: 'The source specifies "more than three back-and-forth exchanges"; we say "several turns". Deliberate: a parent cannot reliably count exchanges in ordinary conversation, and an uncountable criterion would make the answer unreliable. Ours is therefore slightly looser than the source.',
  },
  DQ05: {
    whyValid: 'Both describe the child taking the initiative to seek out peers for play when none are present. Same behavior, same trigger condition.',
    difference: 'Source example ("Can I play with Alex?") dropped. Of the sixteen, this wording sits closest to its source item — still a rewrite, but worth noting for transparency.',
  },
  DQ06: {
    whyValid: 'Both describe prosocial responding to another person\'s distress, and our question now matches the source in scope: the source says "others", not "another child".',
    difference: 'Our examples (another child, a sibling, a family member) replace the source example ("hugging a crying friend"). We add "try to", which credits the attempt rather than requiring a successful outcome.',
  },
  DQ07: {
    whyValid: 'The source item is explicitly about rule-following or turn-taking in games with peers, and our question now carries the same either/or structure. The mapping is exact.',
    difference: 'Wording only: we reorder the two behaviors and say "keep to the rules" for "follows rules". The scope now matches the source.',
    ruling: {
      taken: 'Adopted the source\'s "or" in place of our "and".',
      why: 'The previous wording was double-barreled. A "No" could not distinguish rule-following from turn-taking, and those carry different clinical meanings. CDC treats them as alternatives, so the item now does too — and it no longer scores stricter than the source it cites.',
    },
  },
  DQ08: {
    whyValid: 'The ALSPAC item was read directly in the paper\'s Appendix (Table A1, item 10) and is present in the 42-month column, so both the item and the age placement are confirmed against the source. The construct — communicating a want deliberately rather than through distress — is unchanged.',
    difference: '"Instead of crying for it" now matches the source\'s "without crying for it" in scope; our earlier "or whining" has been removed. "Using words or gestures" is ours: the source leaves the channel implicit, and naming both keeps an intentional non-verbal request from being scored as a failure.',
  },
  DQ09: {
    whyValid: 'The source construct — naming colors of items on request — is exactly what our question asks. Only the quantity and the language clause are ours.',
    difference: 'THE SOURCE SAYS "A FEW" AND SETS NO NUMBER. "At least three" is still our operationalization, lowered from four. "In any language your child speaks" is also ours.',
    ruling: {
      taken: 'Threshold lowered from four colors to three, and the item made language-neutral.',
      why: 'CDC milestones sit at roughly what 75% of children can do. Four colors was at or past the top of a 4-year band and would have flagged typically-developing children. Three is more defensible — but it is still a judgment, not a source finding, which is why this item alone still carries an open mapping question.',
    },
  },
  DQ10: {
    whyValid: 'Both ask whether the child can anticipate the next event in a story they already know. The knowledge condition ("well-known" / "heard many times") is present in both.',
    difference: 'We restate "well-known" as "heard many times", which is easier for a parent to judge about their own child. No change in difficulty.',
  },
  DQ11: {
    whyValid: 'Rote counting to ten. The source item is three words; our question is the same skill made answerable by a parent.',
    difference: '"Out loud" and "from one to" make explicit what the source leaves implied. "In any language" is ours — counting is learned in the household language, and the source assumes a single-language setting.',
  },
  DQ12: {
    whyValid: 'Sustained attention on a single non-screen activity for five to ten minutes. Both the duration and the screen-time exclusion come from the source, so the item now carries the source\'s full definition rather than part of it.',
    difference: 'Our examples (puzzle, drawing, being read to) partly overlap the source\'s and all name clearly non-screen activities. We state the exclusion in plainer terms than the source\'s "(screen time does not count)".',
    ruling: {
      taken: 'Screen-time exclusion added, and the example "a story" replaced with "being read to".',
      why: 'The exclusion is part of the source item\'s definition, not an optional extra — screen attention is not equivalent to self-directed attention. The old example "a story" could itself have been read as a tablet video, which is exactly the confusion the exclusion exists to prevent.',
    },
  },
  DQ13: {
    whyValid: 'Catching a large thrown ball. The source construct is unchanged; the frequency moved to the answer scale, and the catch is now described in a way that admits age-typical form.',
    difference: 'The source says "most of the time"; we removed that so a "Sometimes" answer stays readable. "Using their arms or hands" is ours and is not in the source.',
  },
  DQ14: {
    whyValid: 'The source contrasts a finger-and-thumb grasp against a fisted grip. Our question describes the same contrast — fingertips against a closed hand — anchored to an occasion a parent can picture.',
    difference: 'Wording rebuilt from scratch. An earlier draft of this question reproduced the source item almost word for word and was rejected in review; this version shares only the word "crayon" with it.',
  },
  DQ15: {
    whyValid: 'The source item was read in the paper\'s Appendix (Table A4, item 30) and appears in the 42-month column, confirming both the skill and the age. The question now covers descending only, so it maps to exactly one source item.',
    difference: 'We do not carry the source\'s "like an adult", which is a comparison a parent cannot reliably judge. The contrast with putting both feet on the same step is ours, added so a parent knows what the alternative looks like.',
    ruling: {
      taken: 'Narrowed to descending only. The ascending item (Table A4, item 26) is no longer cited here.',
      why: 'The merged version asked about two separate source items at once, so a child who managed stairs going up but not going down had no accurate answer. Descending is the later and harder skill, and a child who descends with alternating feet has almost certainly mastered ascending — one item therefore captures nearly all the information, and Motor Skills stays at four.',
    },
  },
  DQ16: {
    whyValid: 'Threading small objects onto a string, requiring a pincer grasp and two-handed coordination. The source item appears in both the 30- and 42-month columns, confirming the age placement.',
    difference: 'We replace "thread" with plainer wording and generalize from beads to other small objects and from a string to a shoelace, so families without beads at home can still answer.',
  },
};

// MAPPING verdict only — whether our question is faithful to the source it
// cites. Distinct from approval: all sixteen remain pending_pediatrician_approval
// regardless of what this says. An item is 'review' when the reviewer round
// left an open mapping question on it (DATASET_REVIEW.openMappingItems), and
// 'verified' otherwise. DQ09 is the one open item: its "at least three" is our
// number, and the source sets none.
const VERDICT = Object.fromEntries(
  DATASET_QUESTIONS.map((q) => [
    q.questionId,
    DATASET_REVIEW.openMappingItems.includes(q.questionId) ? 'review' : 'verified',
  ]),
);

// Reviewer decision, round 2 — read from the catalogue's single source of
// truth (constants/datasetQuestions.js DATASET_REVIEW). It approves WORDING
// for that round only: not pediatrician sign-off, and it does not activate
// anything — the packet must keep saying so.
const REVIEWER_DECISION = DATASET_REVIEW.decision;
const REVIEWER_ROUND = `${DATASET_REVIEW.round} · ${DATASET_REVIEW.decidedOn}`;

// Items whose wording changed in that review round.
const REVISED = DATASET_REVIEW.revisedItems;

// Fail loudly if the catalogue has moved on without the hand-written review
// commentary below being updated to match — a missing NOTES/VERDICT entry
// would otherwise render a broken card or throw an opaque error mid-build.
(function assertPacketCoverage() {
  const problems = [];
  if (DATASET_QUESTIONS.length !== 16) {
    problems.push(`catalogue has ${DATASET_QUESTIONS.length} questions, expected 16`);
  }
  const ids = new Set(DATASET_QUESTIONS.map((q) => q.questionId));
  for (const q of DATASET_QUESTIONS) {
    if (!NOTES[q.questionId]) problems.push(`${q.questionId}: no NOTES entry in the packet`);
    if (!VERDICT[q.questionId]) problems.push(`${q.questionId}: no VERDICT entry`);
  }
  for (const id of [...DATASET_REVIEW.revisedItems, ...DATASET_REVIEW.openMappingItems]) {
    if (!ids.has(id)) problems.push(`DATASET_REVIEW references unknown id ${id}`);
  }
  const t = DATASET_REVIEW.tally;
  if (t.approved + t.revise + t.rejected + t.unmarked !== DATASET_QUESTIONS.length) {
    problems.push('DATASET_REVIEW.tally does not sum to the catalogue size');
  }
  if (problems.length) {
    throw new Error(`Dataset question review packet is out of sync with the catalogue:\n  - ${problems.join('\n  - ')}`);
  }
})();

const DOMAIN_ORDER = ['Communication', 'Social Skills', 'Cognitive', 'Motor Skills'];

function ageLabel(months) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return m ? `${y} yr ${m} mo` : `${y} years`;
}

function renderItem(q) {
  const src = DATASET_SOURCES[q.sourceKey];
  const n = NOTES[q.questionId];
  const verdict = VERDICT[q.questionId];
  const isReview = verdict === 'review';

  const rulingBlock = n.ruling ? `
      <div class="ruling">
        <p class="ruling-eyebrow">Reviewer ruling &middot; 2026-08-28</p>
        <h4 class="ruling-q">${esc(n.ruling.taken)}</h4>
        <p class="ruling-why">${esc(n.ruling.why)}</p>
        <p class="ruling-status">Recommendation from a structured content review. <strong>Pediatrician confirmation is still outstanding.</strong></p>
      </div>` : '';

  return `
    <article class="item ${isReview ? 'item--review' : ''} ${REVISED.indexOf(q.questionId) !== -1 ? 'item--revised' : ''}" id="${esc(q.questionId)}" data-domain="${esc(q.domain)}" data-verdict="${verdict}">
      <header class="item-head">
        <span class="qid">${esc(q.questionId)}</span>
        <div class="item-meta">
          <span class="meta"><span class="meta-k">Domain</span>${esc(q.domain)}</span>
          <span class="meta"><span class="meta-k">Target age</span>${esc(ageLabel(q.minAgeMonths))} +</span>
          <span class="meta"><span class="meta-k">Generation</span>AI-generated adaptation</span>
        </div>
        ${REVISED.indexOf(q.questionId) !== -1 ? '<span class="revised-tag">Wording revised</span>' : ''}
        <span class="verdict verdict--${verdict}">${isReview ? 'Open mapping question' : 'Mapping verified'}</span>
      </header>

      <div class="compare">
        <div class="side side--source">
          <p class="side-label">The source says</p>
          <blockquote class="verbatim">${esc(q.sourceItemVerbatim)}</blockquote>
          <p class="side-attrib"><strong>${esc(src.shortName)}</strong><br>${esc(src.sourceType)}</p>
        </div>
        <div class="side side--ours">
          <p class="side-label">KinderCura asks</p>
          <p class="ours">${esc(q.text)}</p>
          <p class="side-attrib">Answered on the <strong>Yes / Sometimes / No</strong> scale</p>
        </div>
      </div>

      <dl class="rationale">
        <div>
          <dt>How we adapted it</dt>
          <dd>${esc(q.adaptationNote)}</dd>
        </div>
        <div>
          <dt>Why the mapping is valid</dt>
          <dd>${esc(n.whyValid)}</dd>
        </div>
        <div>
          <dt>Difference from the source</dt>
          <dd>${esc(n.difference)}</dd>
        </div>
      </dl>
      ${rulingBlock}

      <div class="recorded">
        <span class="recorded-mark" aria-hidden="true">&#10003;</span>
        <div>
          <p class="recorded-title">Wording approved &mdash; ${esc(REVIEWER_ROUND)}</p>
          <p class="recorded-sub">Reviewer recommendation. Not pediatrician sign-off, and not an instruction to activate.</p>
        </div>
      </div>

      <div class="verdictbar">
        <p class="vb-label">Pediatrician decision</p>
        <div class="choices" role="group" aria-label="Decision for ${esc(q.questionId)}">
          <label class="choice choice--yes"><input type="radio" name="d-${esc(q.questionId)}" value="approve"><span>Approve</span></label>
          <label class="choice choice--edit"><input type="radio" name="d-${esc(q.questionId)}" value="revise"><span>Revise</span></label>
          <label class="choice choice--no"><input type="radio" name="d-${esc(q.questionId)}" value="reject"><span>Reject</span></label>
        </div>
        <input class="vb-note" type="text" name="n-${esc(q.questionId)}" placeholder="Note for the team (optional)" aria-label="Note for ${esc(q.questionId)}">
      </div>
    </article>`;
}

const bySrc = {};
for (const q of DATASET_QUESTIONS) {
  const k = DATASET_SOURCES[q.sourceKey].shortName;
  bySrc[k] = (bySrc[k] || 0) + 1;
}

const sections = DOMAIN_ORDER.map((d) => {
  const qs = DATASET_QUESTIONS.filter((q) => q.domain === d);
  return `
  <section class="domain" id="${d.replace(/\s+/g, '-').toLowerCase()}">
    <h2 class="domain-title">${esc(d)}<span class="domain-count">${qs.length} questions</span></h2>
    ${qs.map(renderItem).join('\n')}
  </section>`;
}).join('\n');

const reviewIds = Object.keys(VERDICT).filter((k) => VERDICT[k] === 'review');

const checklistRows = DATASET_QUESTIONS.map((q) => {
  const v = VERDICT[q.questionId];
  const n = NOTES[q.questionId];
  return `      <tr data-check="${esc(q.questionId)}">
        <td class="ck-id"><a href="#${esc(q.questionId)}">${esc(q.questionId)}</a></td>
        <td class="ck-dom">${esc(q.domain)}</td>
        <td class="ck-q">${esc(q.text)}</td>
        <td class="ck-ask"><span class="ck-approved">Approved (wording)</span>${n.ruling ? '<div class="ck-ruling">' + esc(n.ruling.taken) + '</div>' : ''}${VERDICT[q.questionId] === 'review' ? '<div class="ck-open">Open mapping question remains</div>' : ''}</td>
        <td class="ck-state"><span class="ck-box" data-box="${esc(q.questionId)}">&nbsp;</span></td>
      </tr>`;
}).join('\n');

const sourceRows = Object.keys(DATASET_SOURCES).map((k) => {
  const s = DATASET_SOURCES[k];
  const n = DATASET_QUESTIONS.filter((q) => q.sourceKey === k).length;
  return `      <tr>
        <td class="sr-n">${n}</td>
        <td><strong>${esc(s.shortName)}</strong><div class="sr-type">${esc(s.sourceType)}</div></td>
        <td class="sr-cite">${esc(s.citation)}<div class="sr-ver">${esc(s.version)}</div></td>
      </tr>`;
}).join('\n');

const html = `<title>Dataset Question Review Packet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* ── Tokens ────────────────────────────────────────────────────────────────
   Palette taken from KinderCura's own system (CSS files/kc-tokens.css):
   warm muted green on warm neutrals. Light palette on bare :root so the
   un-stamped "system" default resolves; dark redefined twice so both the OS
   setting and an explicit toggle win in their own direction. */
:root {
  --primary:      #6B8E6F;
  --primary-dark: #5A7560;
  --ink:          #3D4738;
  --ink-soft:     #6B7967;
  --rule:         #DDD9CC;
  --rule-soft:    #EBE8DE;
  --ground:       #F6F5EF;
  --surface:      #FFFFFF;
  --recess:       #F0EFE6;
  --positive:     #4C6B45;
  --positive-bg:  #E9F0E6;
  --caution:      #8A6A1F;
  --caution-bg:   #FBF3DF;
  --attention:    #9C4F43;
  --on-accent:    #FFFFFF;
  --shadow:       0 1px 2px rgba(61,71,56,.06), 0 8px 24px -16px rgba(61,71,56,.28);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --primary:      #97B79B;
    --primary-dark: #B2CCB5;
    --ink:          #E7E7DD;
    --ink-soft:     #A3A895;
    --rule:         #3B4036;
    --rule-soft:    #2F332C;
    --ground:       #1C1F19;
    --surface:      #24281F;
    --recess:       #1F231C;
    --positive:     #9DBE93;
    --positive-bg:  #2A3326;
    --caution:      #D7B266;
    --caution-bg:   #332C18;
    --attention:    #D08A7C;
    --on-accent:    #1C1F19;
    --shadow:       0 1px 2px rgba(0,0,0,.3), 0 8px 24px -16px rgba(0,0,0,.7);
  }
}
:root[data-theme="dark"] {
  --primary:      #97B79B;
  --primary-dark: #B2CCB5;
  --ink:          #E7E7DD;
  --ink-soft:     #A3A895;
  --rule:         #3B4036;
  --rule-soft:    #2F332C;
  --ground:       #1C1F19;
  --surface:      #24281F;
  --recess:       #1F231C;
  --positive:     #9DBE93;
  --positive-bg:  #2A3326;
  --caution:      #D7B266;
  --caution-bg:   #332C18;
  --attention:    #D08A7C;
  --on-accent:    #1C1F19;
  --shadow:       0 1px 2px rgba(0,0,0,.3), 0 8px 24px -16px rgba(0,0,0,.7);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 62rem; margin: 0 auto; padding: 0 1.5rem 6rem; }

h1, h2, h3, h4 {
  font-family: Fraunces, ui-serif, Georgia, "Times New Roman", serif;
  text-wrap: balance;
  margin: 0;
  font-weight: 600;
}

/* ── Masthead ───────────────────────────────────────────────────────────── */
.masthead { padding: 4rem 0 2rem; border-bottom: 2px solid var(--ink); }
.eyebrow {
  font-family: "IBM Plex Mono", ui-monospace, monospace;
  font-size: .72rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--primary-dark);
  margin: 0 0 1rem;
}
.masthead h1 { font-size: clamp(2.1rem, 5.5vw, 3.2rem); line-height: 1.08; letter-spacing: -.02em; }
.standfirst {
  font-size: 1.06rem;
  color: var(--ink-soft);
  max-width: 40rem;
  margin: 1.1rem 0 0;
}

/* ── Status strip ───────────────────────────────────────────────────────── */
.status {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  margin: 2rem 0 0;
  border-radius: 3px;
  overflow: hidden;
}
.status div { background: var(--surface); padding: .95rem 1.1rem; }
.status .n {
  font-family: Fraunces, serif;
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  display: block;
}
.status .k {
  font-size: .7rem;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-top: .4rem;
  display: block;
}
.status .n--hold { color: var(--caution); }
.status .n--zero { color: var(--primary-dark); }

.notice {
  margin: 1.75rem 0 0;
  padding: 1.1rem 1.3rem;
  background: var(--surface);
  border-left: 3px solid var(--primary);
  border-radius: 0 3px 3px 0;
  font-size: .92rem;
  box-shadow: var(--shadow);
}
.notice p { margin: 0 0 .6rem; }
.notice p:last-child { margin-bottom: 0; }
/* The revision banner is the first thing a returning reviewer needs, so it
   takes the caution edge rather than the neutral accent edge. */
.notice--revision { border-left-color: var(--caution); background: var(--caution-bg); }
.notice strong { color: var(--ink); }

/* ── How to use ─────────────────────────────────────────────────────────── */
.howto { margin-top: 2.5rem; }
.howto h2 { font-size: 1.1rem; margin-bottom: .8rem; }
.howto ol { margin: 0; padding-left: 1.2rem; font-size: .93rem; color: var(--ink-soft); }
.howto li { margin-bottom: .4rem; }
.howto li strong { color: var(--ink); }

/* ── Sources table ──────────────────────────────────────────────────────── */
.tablewrap { overflow-x: auto; margin-top: 1rem; }
table { border-collapse: collapse; width: 100%; font-size: .87rem; }
th {
  text-align: left;
  font-size: .68rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  font-weight: 600;
  padding: 0 .8rem .5rem;
  border-bottom: 1px solid var(--rule);
}
td { padding: .85rem .8rem; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
.sr-n { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--primary-dark); width: 2.5rem; }
.sr-type, .sr-ver { font-size: .78rem; color: var(--ink-soft); margin-top: .2rem; }
.sr-cite { font-family: "IBM Plex Mono", monospace; font-size: .76rem; line-height: 1.5; }

/* ── Domain sections ────────────────────────────────────────────────────── */
.domain { margin-top: 4rem; }
.domain-title {
  font-size: 1.55rem;
  padding-bottom: .6rem;
  border-bottom: 1px solid var(--rule);
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.domain-count {
  font-family: "IBM Plex Mono", monospace;
  font-size: .72rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--ink-soft);
  font-weight: 400;
}

/* ── Item card ──────────────────────────────────────────────────────────── */
.item {
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 4px;
  margin-top: 1.5rem;
  overflow: hidden;
  box-shadow: var(--shadow);
  scroll-margin-top: 1rem;
}
/* Amber left edge marks the four items awaiting a ruling. State, not decor. */
.item--review { border-left: 4px solid var(--caution); }

.item-head {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 1.1rem 1.4rem;
  background: var(--recess);
  border-bottom: 1px solid var(--rule);
}
.qid {
  font-family: "IBM Plex Mono", monospace;
  font-size: .95rem;
  font-weight: 500;
  letter-spacing: .04em;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--rule);
  padding: .18rem .55rem;
  border-radius: 3px;
}
.item-meta { display: flex; gap: 1.3rem; flex-wrap: wrap; flex: 1; }
.meta { font-size: .82rem; }
.meta-k {
  display: block;
  font-size: .64rem;
  letter-spacing: .09em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.verdict {
  font-size: .7rem;
  letter-spacing: .07em;
  text-transform: uppercase;
  font-weight: 600;
  padding: .3rem .65rem;
  border-radius: 999px;
  white-space: nowrap;
}
.verdict--verified { background: var(--positive-bg); color: var(--positive); }
.verdict--review { background: var(--caution-bg); color: var(--caution); }

/* ── The side-by-side. This comparison is the whole point of the page. ──── */
.compare { display: grid; grid-template-columns: 1fr 1fr; }
@media (max-width: 42rem) { .compare { grid-template-columns: 1fr; } }

.side { padding: 1.4rem; }
.side--source { background: var(--recess); border-right: 1px solid var(--rule); }
@media (max-width: 42rem) {
  .side--source { border-right: 0; border-bottom: 1px solid var(--rule); }
}
.side-label {
  font-family: "IBM Plex Mono", monospace;
  font-size: .68rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin: 0 0 .7rem;
}
/* Monospace signals quoted-exact text: this is the source's own wording,
   reproduced without edit, not our prose. */
.verbatim {
  margin: 0;
  font-family: "IBM Plex Mono", monospace;
  font-size: .87rem;
  line-height: 1.6;
  color: var(--ink);
  padding-left: .9rem;
  border-left: 2px solid var(--primary);
}
.ours {
  margin: 0;
  font-family: Fraunces, serif;
  font-size: 1.08rem;
  line-height: 1.45;
  color: var(--ink);
}
.side-attrib { margin: .9rem 0 0; font-size: .76rem; color: var(--ink-soft); line-height: 1.5; }

/* ── Rationale ──────────────────────────────────────────────────────────── */
.rationale {
  margin: 0;
  padding: 1.3rem 1.4rem;
  border-top: 1px solid var(--rule);
  display: grid;
  gap: 1rem;
}
.rationale > div { display: grid; gap: .25rem; }
.rationale dt {
  font-size: .66rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  font-weight: 600;
}
.rationale dd { margin: 0; font-size: .9rem; line-height: 1.6; }

/* ── Decision block ─────────────────────────────────────────────────────── */
.ruling {
  margin: 0 1.4rem 1.4rem;
  padding: 1.2rem 1.3rem;
  background: var(--caution-bg);
  border: 1px solid var(--caution);
  border-radius: 3px;
}
.ruling-eyebrow {
  font-family: "IBM Plex Mono", monospace;
  font-size: .66rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--caution);
  margin: 0 0 .5rem;
  font-weight: 500;
}
.ruling-q { font-size: 1.05rem; margin: 0 0 .6rem; color: var(--ink); }
.ruling-why { margin: 0 0 .8rem; font-size: .89rem; line-height: 1.6; }
.ruling-status {
  margin: .8rem 0 0;
  padding-top: .7rem;
  border-top: 1px solid var(--caution);
  font-size: .82rem;
  line-height: 1.55;
}
.revised-tag {
  font-size: .66rem;
  letter-spacing: .07em;
  text-transform: uppercase;
  font-weight: 600;
  padding: .28rem .55rem;
  border-radius: 999px;
  white-space: nowrap;
  background: var(--surface);
  border: 1px dashed var(--caution);
  color: var(--caution);
}
.item--revised { border-left: 4px solid var(--caution); }

/* ── Decision controls ──────────────────────────────────────────────────── */
/* The reviewer's decision is RECORDED STATE, not a control: flat, quiet, and
   not clickable, so it cannot be confused with the pediatrician's own pass
   directly below it. */
.recorded {
  display: flex;
  align-items: flex-start;
  gap: .7rem;
  padding: .85rem 1.4rem;
  border-top: 1px solid var(--rule);
  background: var(--positive-bg);
}
.recorded-mark {
  color: var(--positive);
  font-weight: 700;
  line-height: 1.35;
}
.recorded-title {
  margin: 0;
  font-size: .84rem;
  font-weight: 600;
  color: var(--positive);
}
.recorded-sub {
  margin: .15rem 0 0;
  font-size: .76rem;
  color: var(--ink-soft);
  line-height: 1.5;
}
.ck-approved {
  font-size: .76rem;
  font-weight: 600;
  color: var(--positive);
  white-space: nowrap;
}
.ck-ruling { font-size: .76rem; color: var(--ink-soft); margin-top: .2rem; line-height: 1.45; }
.ck-open { font-size: .76rem; color: var(--caution); margin-top: .2rem; }
.status .n--ok { color: var(--positive); }

.verdictbar {
  display: flex;
  align-items: center;
  gap: .9rem;
  flex-wrap: wrap;
  padding: 1rem 1.4rem;
  background: var(--recess);
  border-top: 1px solid var(--rule);
}
.vb-label {
  font-size: .66rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-soft);
  font-weight: 600;
  margin: 0;
}
.choices { display: flex; gap: .4rem; }
.choice { position: relative; }
.choice input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
.choice span {
  display: block;
  padding: .35rem .8rem;
  font-size: .82rem;
  font-weight: 500;
  border: 1px solid var(--rule);
  border-radius: 3px;
  background: var(--surface);
  color: var(--ink-soft);
  cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
.choice input:hover + span { border-color: var(--ink-soft); }
.choice input:focus-visible + span { outline: 2px solid var(--primary); outline-offset: 2px; }
/* Text on a filled status swatch. Comes from --on-accent, which flips with
   the theme: the dark palette lightens the status colors, so white text on
   them would not hold contrast. Never hard-code this. */
.choice--yes input:checked + span { background: var(--positive); border-color: var(--positive); color: var(--on-accent); }
.choice--edit input:checked + span { background: var(--caution); border-color: var(--caution); color: var(--on-accent); }
.choice--no input:checked + span { background: var(--attention); border-color: var(--attention); color: var(--on-accent); }

.vb-note {
  flex: 1;
  min-width: 12rem;
  padding: .4rem .65rem;
  font: inherit;
  font-size: .84rem;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 3px;
}
.vb-note:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }

/* ── Checklist ──────────────────────────────────────────────────────────── */
.checklist { margin-top: 4.5rem; padding-top: 2rem; border-top: 2px solid var(--ink); }
.checklist h2 { font-size: 1.55rem; }
.ck-id a {
  font-family: "IBM Plex Mono", monospace;
  font-weight: 500;
  color: var(--primary-dark);
  text-decoration: none;
  border-bottom: 1px solid transparent;
}
.ck-id a:hover, .ck-id a:focus-visible { border-bottom-color: var(--primary-dark); }
.ck-dom { font-size: .8rem; color: var(--ink-soft); white-space: nowrap; }
.ck-q { min-width: 16rem; }
.ck-ask { font-size: .82rem; color: var(--caution); min-width: 12rem; }
.ck-none { color: var(--ink-soft); }
.ck-box {
  display: inline-block;
  width: 1.15rem;
  height: 1.15rem;
  border: 1.5px solid var(--ink-soft);
  border-radius: 2px;
  text-align: center;
  line-height: 1.05rem;
  font-weight: 700;
  font-size: .85rem;
}
.ck-box[data-state="approve"] { background: var(--positive); border-color: var(--positive); color: var(--on-accent); }
.ck-box[data-state="revise"]  { background: var(--caution);  border-color: var(--caution);  color: var(--on-accent); }
.ck-box[data-state="reject"]  { background: var(--attention); border-color: var(--attention); color: var(--on-accent); }

.summary {
  margin-top: 2rem;
  padding: 1.2rem 1.3rem;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 3px;
}
.summary h3 { font-size: 1rem; margin-bottom: .5rem; }
.summary p { font-size: .87rem; color: var(--ink-soft); margin: 0 0 .8rem; }
#summaryOut {
  width: 100%;
  min-height: 9rem;
  font-family: "IBM Plex Mono", monospace;
  font-size: .78rem;
  line-height: 1.6;
  padding: .8rem;
  color: var(--ink);
  background: var(--recess);
  border: 1px solid var(--rule);
  border-radius: 3px;
  resize: vertical;
}
.btn {
  font: inherit;
  font-size: .84rem;
  font-weight: 500;
  padding: .45rem .9rem;
  border-radius: 3px;
  border: 1px solid var(--rule);
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
}
.btn:hover { border-color: var(--ink-soft); }
.btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.btnrow { display: flex; gap: .5rem; margin-top: .8rem; flex-wrap: wrap; align-items: center; }
.saved { font-size: .78rem; color: var(--ink-soft); }

footer {
  margin-top: 4rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--rule);
  font-size: .8rem;
  color: var(--ink-soft);
}
footer code {
  font-family: "IBM Plex Mono", monospace;
  background: var(--recess);
  padding: .1rem .35rem;
  border-radius: 2px;
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
</style>

<div class="wrap">
  <header class="masthead">
    <p class="eyebrow">KinderCura &middot; Question Origin &middot; Dataset Questions</p>
    <h1>Dataset Question Review Packet</h1>
    <p class="standfirst">Sixteen candidate screening questions, each adapted for KinderCura from a published
      external developmental source. None is in use. Each needs your approval before it can be activated.</p>

    <div class="status">
      <div><span class="n n--ok">${DATASET_QUESTIONS.length}</span><span class="k">Wording approved</span></div>
      <div><span class="n">${DATASET_QUESTIONS.length}</span><span class="k">Pending your approval</span></div>
      <div><span class="n n--zero">0</span><span class="k">Active</span></div>
      <div><span class="n n--hold">${reviewIds.length}</span><span class="k">Open mapping question${reviewIds.length === 1 ? '' : 's'}</span></div>
    </div>

    <div class="notice notice--revision">
      <p><strong>${esc(DATASET_REVIEW.round)} complete &mdash; all ${DATASET_QUESTIONS.length} marked Approve.</strong>
        Approved ${DATASET_REVIEW.tally.approved} &middot; Revise ${DATASET_REVIEW.tally.revise}
        &middot; Rejected ${DATASET_REVIEW.tally.rejected} &middot; Unmarked ${DATASET_REVIEW.tally.unmarked}.</p>
      <p>That decision approves the <strong>wording</strong> of these questions for that review round.
        It came from a structured clinical content review, <strong>not from a pediatrician</strong>.</p>
      <p><strong>Pediatrician sign-off is still outstanding, and approval in this packet does not
        activate anything.</strong> All ${DATASET_QUESTIONS.length} remain pending your approval and inactive.
        ${REVISED.length} were reworded in that round; four carry a reviewer ruling recorded on the item.
        ${esc(DATASET_REVIEW.openMappingItems.join(', '))} still ${DATASET_REVIEW.openMappingItems.length === 1 ? 'has an open' : 'have open'}
        mapping question${DATASET_REVIEW.openMappingItems.length === 1 ? '' : 's'} that approval did not settle.</p>
    </div>

    <div class="notice">
      <p><strong>These are our words, not the sources'.</strong> Every question below was newly written for
        KinderCura from a developmental concept in a published source. The source's own item text is shown
        beside ours so you can judge the adaptation. No source has written, reviewed, or endorsed our wording.</p>
      <p><strong>This is not a validated screening instrument.</strong> CDC states on both cited pages that its
        Learn the Signs. Act Early. materials are not a substitute for standardized, validated developmental
        screening tools. Nothing derived from them here is either.</p>
    </div>
  </header>

  <section class="howto">
    <h2>How to use this packet</h2>
    <ol>
      <li>Read each pair: <strong>the source item on the left, our question on the right.</strong></li>
      <li>Check the <strong>Difference from the source</strong> line &mdash; that is where our wording departs from the source, stated for every item.</li>
      <li>Nine items are tagged <strong>Wording revised</strong>. Four of those carry a <strong>Reviewer ruling</strong> block explaining a judgment that was taken on your behalf and why &mdash; confirm or overturn each.</li>
      <li>One item, <strong>DQ09</strong>, still carries an open mapping question: its color threshold is our number, not the source's.</li>
      <li>Each item shows the reviewer's recorded decision. Below it, <strong>Pediatrician decision</strong> is yours &mdash; mark Approve, Revise or Reject. Your marks are saved in this browser and collected in the checklist at the end.</li>
    </ol>

    <h2 style="margin-top:2rem;">The sources</h2>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Items</th><th>Source</th><th>Reference &amp; version</th></tr></thead>
        <tbody>
${sourceRows}
        </tbody>
      </table>
    </div>
  </section>

${sections}

  <section class="checklist">
    <h2>Approval checklist</h2>
    <p class="standfirst" style="font-size:.95rem;">All 16 were approved on wording by the reviewer.
      Nine were reworded; four carry a reviewer ruling to confirm or overturn. DQ09 still has an open
      mapping question. None of this activates a question &mdash; that needs your approval and then a
      deliberate activation step.</p>
    <div class="tablewrap">
      <table>
        <thead><tr><th>ID</th><th>Domain</th><th>Question</th><th>Reviewer decision</th><th>Mark</th></tr></thead>
        <tbody>
${checklistRows}
        </tbody>
      </table>
    </div>

    <div class="summary">
      <h3>Your decisions</h3>
      <p>Updates as you mark items above. Copy this back to the development team.</p>
      <textarea id="summaryOut" readonly aria-label="Decision summary"></textarea>
      <div class="btnrow">
        <button class="btn" id="copyBtn" type="button">Copy summary</button>
        <button class="btn" id="clearBtn" type="button">Clear all marks</button>
        <span class="saved" id="savedNote"></span>
      </div>
    </div>
  </section>

  <footer>
    <p>Generated from <code>constants/datasetQuestions.js</code>. Question wording, sources, citations and
      verbatim source items are read directly from that file, so this packet cannot drift from the code.</p>
    <p>All sixteen questions are stored as <code>approvalStatus = pending_pediatrician_approval</code> and
      <code>isActive = false</code>. KinderCura refuses to activate a dataset question that is not approved,
      so nothing here can reach a parent's assessment until it is approved and then activated deliberately.</p>
  </footer>
</div>

<script>
(function () {
  var KEY = 'kc-dq-review-v1';
  var IDS = ${JSON.stringify(DATASET_QUESTIONS.map((q) => q.questionId))};
  var REVIEW = ${JSON.stringify(reviewIds)};

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(state) {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      note('Saved in this browser');
    } catch (e) {
      note('Could not save in this browser - copy your summary before closing');
    }
  }
  function note(msg) {
    var el = document.getElementById('savedNote');
    if (el) el.textContent = msg;
  }

  var state = load();

  function render() {
    IDS.forEach(function (id) {
      var rec = state[id] || {};
      var box = document.querySelector('[data-box="' + id + '"]');
      if (box) {
        if (rec.decision) {
          box.setAttribute('data-state', rec.decision);
          box.textContent = rec.decision === 'approve' ? '\\u2713' : (rec.decision === 'reject' ? '\\u2715' : '\\u2013');
        } else {
          box.removeAttribute('data-state');
          box.innerHTML = '&nbsp;';
        }
      }
    });

    var lines = [];
    lines.push('KinderCura - Dataset Question PEDIATRICIAN decisions');
    lines.push('(Reviewer round 2 already recorded: 16 approved on wording, 0 revise, 0 rejected.)');
    lines.push('Pediatrician sign-off outstanding. Approval here does not activate any question.');
    lines.push('');
    var counts = { approve: 0, revise: 0, reject: 0, none: 0 };
    IDS.forEach(function (id) {
      var rec = state[id] || {};
      var d = rec.decision || 'not yet marked';
      counts[rec.decision || 'none'] += 1;
      var line = id + ': ' + d.toUpperCase();
      if (rec.note) line += ' - ' + rec.note;
      if (REVIEW.indexOf(id) !== -1) line += '  [open mapping question]';
      lines.push(line);
    });
    lines.push('');
    lines.push('Approved ' + counts.approve + ' / Revise ' + counts.revise
      + ' / Rejected ' + counts.reject + ' / Unmarked ' + counts.none + ' of ' + IDS.length);
    var out = document.getElementById('summaryOut');
    if (out) out.value = lines.join('\\n');
  }

  IDS.forEach(function (id) {
    var rec = state[id] || {};
    document.querySelectorAll('input[name="d-' + id + '"]').forEach(function (input) {
      if (rec.decision === input.value) input.checked = true;
      input.addEventListener('change', function () {
        state[id] = state[id] || {};
        state[id].decision = input.value;
        save(state);
        render();
      });
    });
    var noteInput = document.querySelector('input[name="n-' + id + '"]');
    if (noteInput) {
      if (rec.note) noteInput.value = rec.note;
      noteInput.addEventListener('input', function () {
        state[id] = state[id] || {};
        state[id].note = noteInput.value;
        save(state);
        render();
      });
    }
  });

  var copyBtn = document.getElementById('copyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var out = document.getElementById('summaryOut');
      out.select();
      var done = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(out.value).then(function () {
          copyBtn.textContent = 'Copied';
          setTimeout(function () { copyBtn.textContent = 'Copy summary'; }, 1600);
        }).catch(function () { note('Select the text above and copy manually'); });
        done = true;
      }
      if (!done) note('Select the text above and copy manually');
    });
  }

  var clearBtn = document.getElementById('clearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      state = {};
      try { localStorage.removeItem(KEY); } catch (e) {}
      document.querySelectorAll('.choice input').forEach(function (i) { i.checked = false; });
      document.querySelectorAll('.vb-note').forEach(function (i) { i.value = ''; });
      note('All marks cleared');
      render();
    });
  }

  render();
})();
</script>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log('Wrote ' + OUT + ' (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
console.log('Items rendered: ' + DATASET_QUESTIONS.length);
console.log('Needing review: ' + reviewIds.join(', '));
