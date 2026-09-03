// constants/datasetQuestions.js
// The Dataset Question catalog — origin `dataset_question` (see
// constants/dataOrigin.js). Kept here, in code, for the same reason the core
// bank is: these rows are system-provided and change only by deploy.
//
// WHAT THESE ARE, PRECISELY
// -------------------------
// Each item's developmental CONSTRUCT is taken from a real, named external
// source, and the source's own item text is recorded verbatim in
// `sourceItemVerbatim` so a reviewer can compare the two side by side. Our
// WORDING is newly written for KinderCura — it is NOT the source instrument's
// item text, and must never be presented as such. That is what
// generationMethod records, and what `adaptationNote` explains per item.
//
//   concept  → an external developmental source (cited, checkable)
//   wording  → AI-generated adaptation, written for KinderCura
//   status   → candidate, pending pediatrician review
//
// So: citing CDC or ALSPAC here is a claim about where the developmental idea
// came from. It is NOT a claim that CDC or ALSPAC wrote, endorsed, or validated
// these sentences, and it is NOT a claim that this is a validated instrument.
// CDC says so itself, on both pages cited below: "Learn the Signs. Act Early.
// materials are not a substitute for standardized, validated developmental
// screening tools." Neither, therefore, is anything derived from them here.
//
// WHAT THESE ARE NOT
// ------------------
// Not Core Question Bank items (those came from our pediatrician interview).
// Not Pediatrician Entry items (those have an author and live in
// pedia_custom_questions). Not ML training data — that is TrainingDataset and
// ml/datasets/*.csv, an entirely separate concept.
//
// CDC "Learn the Signs. Act Early." is a developmental MILESTONE REFERENCE for
// surveillance, not a machine-learning dataset. Do not describe it as one.
//
// VERIFICATION HISTORY — read before adding an item
// -------------------------------------------------
// On 2026-08-28 all 16 items were checked against the primary sources. Five
// failed and were revised. The failure was always the same shape: a plausible
// developmental construct attributed to a source that does not actually
// contain it. Two constraints found in the ALSPAC paper caused four of them,
// and both are easy to forget:
//
//   1. ALSPAC's COMMUNICATION subscale was only administered at 6 and 18
//      months (paper §2.1 and Appendix Table A3). It cannot support ANY
//      preschool communication item. Do not cite it for one.
//   2. The whole ALSPAC battery stops at 42 months (3y6m). Nothing above that
//      age can be sourced to ALSPAC at all.
//
// So: before citing a source for a new item, open the source and find the
// item. A construct that "sounds like" the instrument is not a citation.
//
// A second round on 2026-08-28 revised the WORDING of nine items following a
// structured clinical content review. That review is a reviewer
// recommendation, NOT a pediatrician sign-off — every item below remains
// pending_pediatrician_approval and inactive. Three themes ran through it and
// are worth carrying into any future item:
//
//   - Language. Rhyme, color names and rote counting are learned in the
//     household language. An English-only example tests English exposure, not
//     development, so those items now say "in any language".
//   - Double-barreled items. A question joining two skills with "and" cannot
//     be answered when a child has one and not the other, and a "No" then
//     hides which skill is missing. DQ07 and DQ15 were split or narrowed.
//   - Our own additions. Qualifiers we added and the source did not ("with
//     both hands", "or whining", a four-color threshold) were each making the
//     item harder than the source intends. They were removed or lowered.
//
// REVIEWER DECISION — round 2, recorded 2026-08-28
// ------------------------------------------------
// All 16 items marked APPROVE. Approved 16 / Revise 0 / Rejected 0 / Unmarked 0.
//
// READ THAT CAREFULLY: it approves the WORDING, for this reviewer round only.
// It is NOT pediatrician sign-off, and it is NOT clearance to activate. Every
// item below stays approvalStatus = pending_pediatrician_approval,
// isActive = false, approvedBy = null, approvedAt = null. Do not read 16/16
// Approve as permission to seed, activate, or serve these to a parent.
//
// Two wordings quoted in the decision message (DQ06, DQ08) were the
// PRE-revision versions from before the 2026-08-28 content review. Confirmed
// with the reviewer on the same day as a stale paste, not a reversal: both
// keep their revised wording and their recorded rationale. If either is ever
// genuinely to be reverted, that must be its own dated decision — the reasons
// they were changed are in the block comments on those entries.
//
// DQ09 stays flagged. Its "at least three" is OUR operational threshold; the
// source says "a few" and sets no number. Approval of the wording did not
// settle the number, and the reviewer said so explicitly.
//
// PROVENANCE CONVENTION — how a wording change is recorded
// --------------------------------------------------------
// In the block comment above the entry, on one line:
//
//   WORDING REVISED <ISO date> — <reason>. Reviewer recommendation;
//   PEDIATRICIAN CONFIRMATION OUTSTANDING.
//
// Comments, not a schema field, on purpose. Revision history is review
// material and does not belong in every question document; adding a field to
// models/CoreBankQuestion.js for it would widen the schema for something the
// running system never reads. If this history ever needs to be queryable,
// propose the field before adding it.
//
// LIFECYCLE
// ---------
// Every row below is created PENDING and isActive:false. The model refuses to
// activate a dataset_question that is not approved, so "pending" is enforced,
// not decorative. Nothing here reaches a parent assessment: the parent
// screening flow renders the hardcoded DOCTOR_QUESTION_BANK in
// js/parent/screening.js and does not read this collection at all.

const { APPROVAL_STATUS, GENERATION_METHOD } = require('./dataOrigin');

// ── The external sources, written out once ──────────────────────────────────
// Referenced by key below so a citation cannot drift between rows or be
// half-edited. Only sources we have actually opened and read belong here.
const DATASET_SOURCES = Object.freeze({
  // Published, peer-reviewed data descriptor, open access. Its Appendix A
  // prints every questionnaire item verbatim across four tables (A1 social
  // skills, A2 fine motor, A3 communication, A4 gross motor), which is what
  // makes item-level verification possible at all.
  //
  // Scope limits confirmed in the paper — see VERIFICATION HISTORY above:
  // battery administered at 6, 18, 30 and 42 months only; communication items
  // at 6 and 18 months only.
  //
  // Its 30/42-month response scale is "Can do well (2) / Does this but not
  // very well (1) / Has not yet done (0)" — the same three-point structure
  // KinderCura scores as Yes / Sometimes / No.
  ALSPAC_2016: Object.freeze({
    key: 'ALSPAC_2016',
    shortName: 'ALSPAC (Iles-Caven et al., 2016)',
    sourceType: 'Published peer-reviewed research data descriptor (open access)',
    citation:
      'Iles-Caven Y, Golding J, Gregory S, Emond A, Taylor CM (2016). Data relating to early child '
      + 'development in the Avon Longitudinal Study of Parents and Children (ALSPAC), their '
      + 'relationship with prenatal blood mercury and stratification by fish consumption. '
      + 'Data in Brief, 9, 112-122. doi:10.1016/j.dib.2016.08.034',
    version: 'Data in Brief, vol. 9 (2016), pp. 112-122; items from Appendix A (verified 2026-08-28)',
  }),

  // Milestone checklists — a developmental SURVEILLANCE reference, NOT a
  // dataset and NOT an ML training corpus.
  //
  // On `version`: an earlier draft claimed a "2022 revision" that we had not
  // checked. Both pages were then opened directly and carry a page date of
  // May 15, 2026, which is what is recorded here along with our access date.
  // Record what you actually observed on the page — never a revision year
  // recalled from memory.
  //
  // CDC defines a milestone as something 75% or more of children can do by
  // the given age. Useful when describing what a "no" answer does and does
  // not mean.
  CDC_LTSAE_4Y: Object.freeze({
    key: 'CDC_LTSAE_4Y',
    shortName: 'CDC Learn the Signs. Act Early. - 4 Years',
    sourceType: 'Developmental milestone reference (public health surveillance tool)',
    citation:
      'Centers for Disease Control and Prevention (CDC), Learn the Signs. Act Early. - '
      + 'Milestones by 4 Years. cdc.gov/act-early/milestones/4-years.html',
    version: '4-year milestone checklist; CDC page dated May 15, 2026 (accessed 2026-08-28)',
  }),
  CDC_LTSAE_5Y: Object.freeze({
    key: 'CDC_LTSAE_5Y',
    shortName: 'CDC Learn the Signs. Act Early. - 5 Years',
    sourceType: 'Developmental milestone reference (public health surveillance tool)',
    citation:
      'Centers for Disease Control and Prevention (CDC), Learn the Signs. Act Early. - '
      + 'Milestones by 5 Years. cdc.gov/act-early/milestones/5-years.html',
    version: '5-year milestone checklist; CDC page dated May 15, 2026 (accessed 2026-08-28)',
  }),
});

// The four scoring domains in routes/assessments.js. A question scoring into
// anything else would never be counted, so the seed script asserts against
// this list rather than trusting the strings below.
const SCORING_DOMAINS = Object.freeze(['Communication', 'Social Skills', 'Cognitive', 'Motor Skills']);

// ── The candidate questions ─────────────────────────────────────────────────
// Preschool focus, roughly 3-5 years. No infant items, no toddler autism
// screening items. All parent-report, all observable behavior, all answerable
// on the existing Yes / Sometimes / No scale. Each was checked against the 34
// core-bank questions and the pediatrician-entered questions to avoid overlap.
//
// Per item:
//   sourceItemVerbatim — the source's own item text, quoted exactly. This is
//                        the thing our wording must NOT look like.
//   sourceConstruct    — which developmental idea we took from it.
//   adaptationNote     — how our wording differs, and any place we knowingly
//                        went beyond the source (those are the items a
//                        pediatrician has to rule on, not us).
//   minAgeMonths       — OUR age placement for KinderCura, not a figure read
//                        out of the source.
const DATASET_QUESTIONS = Object.freeze([
  // ── Communication ─────────────────────────────────────────────────────────
  {
    questionId: 'DQ01',
    domain: 'Communication',
    displayDomain: 'Language',
    minAgeMonths: 48,
    text: 'Does your child talk about something that happened earlier in the day, such as at school or during playtime?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Talks about at least one thing that happened during her day, like "I played soccer."',
    sourceConstruct: 'Language/communication: recounting an event from the day in conversation.',
    adaptationNote: 'Reworded; our own examples (school, playtime) replace the source example.',
  },
  {
    questionId: 'DQ02',
    domain: 'Communication',
    displayDomain: 'Language',
    minAgeMonths: 48,
    text: 'Does your child answer simple questions about what everyday things are used for, such as a spoon or an umbrella?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Answers simple questions like "What is a coat for?" or "What is a crayon for?"',
    sourceConstruct: 'Language/communication: answering simple questions about the function of familiar objects.',
    adaptationNote: 'Reworded; our examples (spoon, umbrella) differ from the source examples (coat, crayon).',
  },
  {
    // REPLACED 2026-08-28. The previous DQ03 asked about "who/what/where/why"
    // questions and cited ALSPAC. Verification found no such item: ALSPAC's
    // communication subscale (Table A3) contains no question-form item and was
    // only administered at 6 and 18 months. The citation was unsupported, so
    // the question was removed rather than re-labeled.
    //
    // WORDING REVISED 2026-08-28 — rhyme is language-specific, so an English
    // example tested English exposure rather than development; the example was
    // moved out of the question text to be supplied per language at
    // translation time. Reviewer recommendation; PEDIATRICIAN CONFIRMATION
    // OUTSTANDING.
    questionId: 'DQ03',
    domain: 'Communication',
    displayDomain: 'Language',
    minAgeMonths: 60,
    text: 'Does your child notice when two words sound alike at the end, or make up words that rhyme — in any language your child speaks?',
    sourceKey: 'CDC_LTSAE_5Y',
    sourceItemVerbatim: 'Uses or recognizes simple rhymes (bat-cat, ball-tall)',
    sourceConstruct: 'Language/communication: recognizing and producing simple rhymes (phonological awareness).',
    adaptationNote: 'Reworded, and both source examples dropped rather than replaced. "Notice when two '
      + 'words sound alike at the end ... or make up words that rhyme" covers the source\'s "recognizes '
      + '... or uses". "In any language your child speaks" is ours and has no counterpart in the source.',
  },
  {
    // RE-CITED 2026-08-28. Concept unchanged (conversational turn-taking), but
    // the ALSPAC citation was withdrawn — its communication subscale ends at
    // 18 months. CDC's 5-year list carries the construct explicitly, so the
    // source and the age both move here.
    questionId: 'DQ04',
    domain: 'Communication',
    displayDomain: 'Language',
    minAgeMonths: 60,
    text: 'Does your child continue a conversation with you over several turns, rather than replying once and stopping?',
    sourceKey: 'CDC_LTSAE_5Y',
    sourceItemVerbatim: 'Keeps a conversation going with more than three back-and-forth exchanges',
    sourceConstruct: 'Language/communication: sustaining a multi-turn conversational exchange.',
    adaptationNote: 'Reworded; avoids the source phrasing "keeps a conversation going" and '
      + '"back-and-forth exchanges". We do not state a turn count, so a parent is not asked to '
      + 'count exchanges; "several turns" is deliberately looser than the source\'s "more than three".',
  },

  // ── Social Skills ─────────────────────────────────────────────────────────
  {
    questionId: 'DQ05',
    domain: 'Social Skills',
    displayDomain: 'Personal-Social',
    minAgeMonths: 48,
    text: 'Does your child ask to go and play with other children when none are nearby?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Asks to go play with children if none are around, like "Can I play with Alex?"',
    sourceConstruct: 'Social/emotional: seeking out peers for play.',
    adaptationNote: 'Reworded and the source example dropped. Of the sixteen, this wording sits closest '
      + 'to its source item — measured at 0.38 against a 0.55 near-verbatim threshold, so comfortably an '
      + 'adaptation rather than a copy. Recorded for transparency; reviewed and approved unchanged.',
  },
  {
    // WORDING REVISED 2026-08-28 — reverted our narrowing of the source's
    // "others" to "another child". Many 4-year-olds show their clearest
    // empathy toward a parent or sibling, so a peers-only item discarded real
    // signal. Reviewer recommendation; PEDIATRICIAN CONFIRMATION OUTSTANDING.
    questionId: 'DQ06',
    domain: 'Social Skills',
    displayDomain: 'Personal-Social',
    minAgeMonths: 48,
    text: 'Does your child try to comfort someone who is hurt or upset — for example another child, a brother or sister, or a family member?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Comforts others who are hurt or sad, like hugging a crying friend',
    sourceConstruct: 'Social/emotional: comforting others who are hurt or sad.',
    adaptationNote: 'Reworded. "Someone" now matches the source\'s "others" in scope, with our own '
      + 'examples (another child, a sibling, a family member) replacing the source example. We add '
      + '"try to", which credits the attempt rather than requiring a successful outcome.',
  },
  {
    // RE-CITED AND REWRITTEN 2026-08-28. The previous DQ07 asked about sharing
    // toys and cited ALSPAC; Table A1 contains no sharing or turn-taking item
    // at any age. CDC's 5-year list does, so the item was rewritten around
    // rule-following and turn-taking in games — which is what that source
    // actually supports — and the sharing element was dropped.
    // WORDING REVISED 2026-08-28 — adopted the source's "or". The previous
    // wording joined the two behaviors with "and", which made it
    // double-barreled: a "No" could not distinguish rule-following from
    // turn-taking, and those carry different clinical meanings. Reviewer
    // recommendation; PEDIATRICIAN CONFIRMATION OUTSTANDING.
    questionId: 'DQ07',
    domain: 'Social Skills',
    displayDomain: 'Personal-Social',
    minAgeMonths: 60,
    text: 'Does your child wait for their turn, or keep to the rules, when playing a game with other children?',
    sourceKey: 'CDC_LTSAE_5Y',
    sourceItemVerbatim: 'Follows rules or takes turns when playing games with other children',
    sourceConstruct: 'Social/emotional: following rules or taking turns in games with peers.',
    adaptationNote: 'Reworded, and the source\'s "or" now preserved exactly — a child meets this item '
      + 'by showing either behavior, as in the source. Our sentence reorders the two and says '
      + '"keep to the rules" for "follows rules".',
  },
  {
    // REWRITTEN 2026-08-28. The previous DQ08 asked about help-seeking under
    // difficulty and cited ALSPAC; the nearest real item (Table A1, row 10,
    // 42-month column) is about REQUESTING without crying, which is a
    // different construct. Neither CDC list contains a help-seeking milestone.
    // Rather than keep a construct with no source, the question was rewritten
    // onto the ALSPAC item that does exist and was verified.
    // WORDING REVISED 2026-08-28 — removed "or whining", which was our
    // addition rather than the source's, is near-universal at 3;6, and is
    // judged subjectively. Broadened to "words or gestures" so a child who
    // communicates the want non-verbally is not scored No. Reviewer
    // recommendation; PEDIATRICIAN CONFIRMATION OUTSTANDING.
    questionId: 'DQ08',
    domain: 'Social Skills',
    displayDomain: 'Personal-Social',
    minAgeMonths: 42,
    text: 'Does your child ask for what they want using words or gestures, instead of crying for it?',
    sourceKey: 'ALSPAC_2016',
    sourceItemVerbatim: 'Asks for what he/she wants without crying for it (Appendix Table A1, item 10, 42-month column)',
    sourceConstruct: 'Social skills scale: communicating a want deliberately rather than through distress.',
    adaptationNote: 'Reworded. "Instead of crying for it" now matches the source\'s "without crying for '
      + 'it" in scope. "Using words or gestures" is ours: the source leaves the channel implicit, and '
      + 'naming both keeps a non-verbal but intentional request from being scored as a failure. '
      + 'Within ALSPAC\'s verified 42-month range.',
  },

  // ── Cognitive ─────────────────────────────────────────────────────────────
  {
    // WORDING REVISED 2026-08-28 — threshold lowered from four to three. CDC
    // milestones sit at roughly what 75% of children can do; four colors is
    // at or past the top of a 4-year band and would have flagged
    // typically-developing children. Also made language-neutral. Reviewer
    // recommendation; PEDIATRICIAN CONFIRMATION OUTSTANDING.
    questionId: 'DQ09',
    domain: 'Cognitive',
    displayDomain: 'Cognitive',
    minAgeMonths: 48,
    text: 'Can your child name at least three colors when you point to them — in any language your child speaks?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Names a few colors of items',
    sourceConstruct: 'Cognitive: naming colors of items.',
    adaptationNote: 'STILL A JUDGMENT CALL, NOT FROM THE SOURCE: the source says "a few" and sets no '
      + 'number. "At least three" remains our operationalization, chosen so the item can be scored '
      + 'consistently between families — lowered from four because four sat at or past the top of the '
      + '4-year band. CDC does NOT define the threshold as three, and this catalog must never state '
      + 'that it does. The number stays open and subject to pediatrician confirmation, and should be '
      + 'checked against whichever norm reference we standardize on; the reviewer round that approved '
      + 'this wording explicitly left that question open. "In any language your child speaks" is also '
      + 'ours: color names are learned in the household language, so an English-only reading would '
      + 'test exposure rather than development.',
  },
  {
    questionId: 'DQ10',
    domain: 'Cognitive',
    displayDomain: 'Cognitive',
    minAgeMonths: 48,
    text: 'Does your child tell you what happens next in a story they have heard many times?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Tells what comes next in a well-known story',
    sourceConstruct: 'Cognitive: anticipating what comes next in a well-known story.',
    adaptationNote: 'Reworded; "well-known" restated as "heard many times", which is easier for a '
      + 'parent to judge.',
  },
  {
    // WORDING REVISED 2026-08-28 — added "in any language". Rote counting is
    // learned in the household language, so an English-only reading tested
    // exposure rather than development. Reviewer recommendation; PEDIATRICIAN
    // CONFIRMATION OUTSTANDING.
    questionId: 'DQ11',
    domain: 'Cognitive',
    displayDomain: 'Cognitive',
    minAgeMonths: 60,
    text: 'Can your child count out loud from one to ten, in any language?',
    sourceKey: 'CDC_LTSAE_5Y',
    sourceItemVerbatim: 'Counts to 10',
    sourceConstruct: 'Cognitive: rote counting to ten.',
    adaptationNote: 'Reworded; "out loud from one to" makes the source\'s three-word item answerable '
      + 'by a parent without interpretation. "In any language" is ours and has no counterpart in the '
      + 'source, which is written for a single-language setting.',
  },
  {
    // WORDING REVISED 2026-08-28 — added the screen-time exclusion. It is part
    // of the source item's definition, not an optional extra: screen attention
    // is not equivalent to self-directed attention, and our previous example
    // "a story" could be read as a tablet video. Reviewer recommendation;
    // PEDIATRICIAN CONFIRMATION OUTSTANDING.
    questionId: 'DQ12',
    domain: 'Cognitive',
    displayDomain: 'Cognitive',
    minAgeMonths: 60,
    text: 'Does your child stay focused on one activity, such as a puzzle, drawing, or being read to, for five to ten minutes? (Do not count time spent on a phone, tablet, or TV.)',
    sourceKey: 'CDC_LTSAE_5Y',
    sourceItemVerbatim: 'Pays attention for 5 to 10 minutes during activities. For example, during story time '
      + 'or making arts and crafts (screen time does not count)',
    sourceConstruct: 'Cognitive: sustaining attention for five to ten minutes during an activity.',
    adaptationNote: 'Reworded; our examples (puzzle, drawing, being read to) partly overlap the '
      + 'source\'s and all name clearly non-screen activities. The source\'s screen-time exclusion is '
      + 'now carried explicitly, stated in plainer terms than the source\'s "(screen time does not '
      + 'count)" so a parent knows exactly what to disregard. The five-to-ten-minute duration is the '
      + 'source\'s, not ours.',
  },

  // ── Motor Skills ──────────────────────────────────────────────────────────
  {
    questionId: 'DQ13',
    domain: 'Motor Skills',
    displayDomain: 'Gross Motor',
    minAgeMonths: 48,
    // The source item reads "catches a large ball most of the time". We drop
    // the frequency qualifier on purpose: KinderCura scores Yes / Sometimes /
    // No, so "most of the time" inside the question makes a "Sometimes" answer
    // unreadable. The frequency belongs in the answer, not the stem.
    //
    // WORDING REVISED 2026-08-28 — replaced our added "with both hands". At
    // 4;0 the expected catch is a trap against the chest with both arms, so
    // the literal reading would have scored age-typical performance as No.
    // Reviewer recommendation; PEDIATRICIAN CONFIRMATION OUTSTANDING.
    text: 'Does your child catch a large ball when it is thrown to them, using their arms or hands?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Catches a large ball most of the time',
    sourceConstruct: 'Movement/physical development: catching a large ball.',
    adaptationNote: 'Reworded; frequency moved out of the stem into the answer scale. "Using their arms '
      + 'or hands" is ours and is not in the source: it is written to admit the age-typical trap against '
      + 'the chest as a catch, which our earlier "with both hands" excluded.',
  },
  {
    // REWRITTEN 2026-08-28. The previous DQ14 read "hold a crayon or pencil
    // between their fingers and thumb rather than in a fist" — which is the
    // source item almost word for word, with "not a fist" swapped for "rather
    // than in a fist". Calling that an AI-generated adaptation overstated the
    // difference, so it was rewritten around the same verified construct.
    questionId: 'DQ14',
    domain: 'Motor Skills',
    displayDomain: 'Fine Motor',
    minAgeMonths: 48,
    text: 'Does your child hold a crayon with their fingertips when drawing, instead of gripping it in a closed hand?',
    sourceKey: 'CDC_LTSAE_4Y',
    sourceItemVerbatim: 'Holds crayon or pencil between fingers and thumb (not a fist)',
    sourceConstruct: 'Movement/physical development: mature finger grasp on a crayon or pencil rather than a fisted grip.',
    adaptationNote: 'Substantially rewritten. Avoids the source phrasing "between fingers and thumb" '
      + 'and "not a fist"; describes the same contrast as fingertips versus a closed hand, and anchors '
      + 'it to an occasion a parent can picture ("when drawing").',
  },
  {
    // REVISED 2026-08-28. "Without holding on" was our own addition and made
    // the item harder than either source item; it has been removed. Our
    // wording now also avoids the source phrase "one foot on each step".
    //
    // WORDING REVISED 2026-08-28 — narrowed to DESCENDING ONLY. The previous
    // wording merged ALSPAC's two separate stair items into one
    // double-barreled question. Descending is the later and harder skill, and
    // a child who descends with alternating feet has almost certainly mastered
    // ascending, so one item carries nearly all the information and Motor
    // Skills stays at four. Reviewer recommendation; PEDIATRICIAN CONFIRMATION
    // OUTSTANDING.
    //
    // The citation was narrowed with the question: this item now maps to
    // Table A4 item 30 (descending) ONLY. Item 26 (ascending) is no longer
    // cited here, because this question no longer asks about it — leaving both
    // would misstate the mapping.
    questionId: 'DQ15',
    domain: 'Motor Skills',
    displayDomain: 'Gross Motor',
    minAgeMonths: 42,
    text: 'Does your child walk down stairs using a different foot for each step, rather than putting both feet on the same step?',
    sourceKey: 'ALSPAC_2016',
    sourceItemVerbatim: 'Can walk down steps like an adult - one foot on each step '
      + '(Appendix Table A4, item 30, 42-month column)',
    sourceConstruct: 'Gross motor scale: descending stairs with alternating feet.',
    adaptationNote: 'Reworded, the unsupported "without holding on" clause removed, and the question '
      + 'narrowed to descending so it maps to exactly one source item. "A different foot for each step" '
      + 'restates the source\'s "one foot on each step", and the contrast with putting both feet on the '
      + 'same step is ours, added so a parent knows what the alternative looks like. We do not carry the '
      + 'source\'s "like an adult", which is a comparison a parent cannot reliably judge.',
  },
  {
    questionId: 'DQ16',
    domain: 'Motor Skills',
    displayDomain: 'Fine Motor',
    minAgeMonths: 42,
    text: 'Can your child put beads or other small objects onto a string or shoelace one after another?',
    sourceKey: 'ALSPAC_2016',
    sourceItemVerbatim: 'Can thread beads on a string (Appendix Table A2, item 24, 30- and 42-month columns)',
    sourceConstruct: 'Fine motor scale: threading small objects, requiring pincer grasp and bimanual coordination.',
    adaptationNote: 'Reworded; "thread" replaced with plainer wording, and generalized to other small '
      + 'objects and to a shoelace.',
  },
]);

/**
 * Expand one catalog entry into the document shape CoreBankQuestion stores.
 *
 * Every provenance field is filled from the entry and the named source — none
 * is defaulted or inferred. The three fields that make this a reviewable
 * candidate rather than a live question are fixed here on purpose:
 *   approvalStatus = PENDING   (a pediatrician has not looked at it)
 *   isActive       = false     (and the model refuses true while pending)
 *   approvedBy/At  = null      (no review has happened)
 *
 * Note what is NOT persisted: sourceItemVerbatim, sourceConstruct and
 * adaptationNote stay in this file. They are review material, not provenance
 * the running system needs, and keeping them here avoids widening the schema.
 * Generate the pediatrician's review packet from this module.
 */
function toQuestionDoc(entry, { importBatchId = null, importedAt = null } = {}) {
  const source = DATASET_SOURCES[entry.sourceKey];
  if (!source) {
    throw new Error(`${entry.questionId}: unknown sourceKey "${entry.sourceKey}" — refusing to build an uncited dataset question.`);
  }
  return {
    questionId: entry.questionId,
    text: entry.text,
    domain: entry.domain,
    displayDomain: entry.displayDomain,
    minAgeMonths: entry.minAgeMonths,
    difficulty: '',
    options: [],

    origin: 'dataset_question',
    // The external source of the CONCEPT. Not an endorsement of our wording.
    sourceCitation: source.citation,
    sourceVersion: source.version,
    // Free-text attribution, kept consistent with the citation above.
    sourcedFrom: source.shortName,
    generationMethod: GENERATION_METHOD.AI_ADAPTATION,

    approvalStatus: APPROVAL_STATUS.PENDING,
    approvedBy: null,
    approvedAt: null,

    importedAt,
    importBatchId,
    isSystemManaged: true,
    isActive: false,
  };
}

// ── Reviewer decision — the completed content-review round ──────────────────
// A RECORD of the structured clinical content review finished on 2026-08-28
// (see REVIEWER DECISION — round 2 in the header comment). It is deliberately
// NOT a per-question schema field — see PROVENANCE CONVENTION above. It is one
// fact about one review round, kept here as the single source of truth so the
// pediatrician review packet (scripts/build-dataset-question-packet.js) and
// the admin Question Origin page cannot drift from each other or from the code.
//
// READ IT THE SAME WAY THE HEADER SAYS: this decision approves WORDING for
// this reviewer round only. It is NOT pediatrician sign-off, it does NOT
// change approvalStatus, and it does NOT permit activation. Every question
// stays approvalStatus = pending_pediatrician_approval and isActive = false
// until a pediatrician rules on it — toQuestionDoc() above enforces that, and
// nothing here touches it.
const DATASET_REVIEW = Object.freeze({
  round: 'Reviewer round 2',
  decidedOn: '2026-08-28',
  // Wording-level decision applied to all 16. One of: approve | revise | reject.
  decision: 'approve',
  tally: Object.freeze({ approved: 16, revise: 0, rejected: 0, unmarked: 0 }),
  // Wording changed in this round. Per-item provenance is in the block
  // comments on each entry above ("WORDING REVISED <date> — <reason>").
  revisedItems: Object.freeze([
    'DQ03', 'DQ06', 'DQ07', 'DQ08', 'DQ09', 'DQ11', 'DQ12', 'DQ13', 'DQ15',
  ]),
  // Approval of the wording did NOT settle these. The pediatrician still has
  // an open clinical question to rule on — see the item's adaptationNote.
  openMappingItems: Object.freeze(['DQ09']),
  caveat:
    'Approves wording for this reviewer round only. Not pediatrician sign-off. '
    + 'Does not change approvalStatus and does not activate any question.',
});

module.exports = {
  DATASET_SOURCES,
  DATASET_QUESTIONS,
  DATASET_REVIEW,
  SCORING_DOMAINS,
  toQuestionDoc,
};
