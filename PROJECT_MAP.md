# KinderCura Project Map

This is a quick reference for finding code without rescanning the repository. The architecture rules are in `CLAUDE.md`, and the verified code excerpts for the four research objectives are in `OBJECTIVE_SOURCE_CODE_REPORT.md`. Line numbers match the code after activity completion was added (Oct 19, 2026).

## Stack
- **Backend:** Node.js and Express 4 (`server.js`). On Vercel, the entry point is `api/index.js`.
- **Database:** MongoDB Atlas, accessed through Mongoose 8 (`db.js`, `models/`). Local development and production share one database.
- **Frontend:** plain HTML, CSS and JS with no build step. Chart.js loads from a CDN, and all pages share the helpers in `/api.js`.
- **ML:** Python 3.12 with scikit-learn, pandas and joblib (`ml/`, `api/ml_*.py`). Node calls it through `ml/model_manager.js`.
- **Key libraries:** bcrypt, jsonwebtoken (JWT auth), multer (uploads), nodemailer, qrcode, @vercel/blob, ejs (legacy pages only).
- **Hosting:** Vercel (`vercel.json`). Uploads go to private Cloudflare R2 or Vercel Blob storage (`services/fileStorage.js`).

## Folders
| Folder | Purpose |
|---|---|
| `routes/` | REST API, mounted under `/api/<name>` in `server.js` |
| `models/` | Mongoose schemas (Child, Assessment, AssessmentAnswer, AssessmentResult, Recommendation, Appointment, User, …) |
| `services/` | Shared backend logic: assessment progress and ML staging, payments, email, file storage, admin report views |
| `constants/` | Domain vocabulary, score bands (`scoring.js`, also used in the browser), developmental staging, question origins |
| `middleware/` | JWT auth and role guards; child access checks for parents and guardians |
| `controllers/` | Guardian, audit and payment handlers |
| `PARENT/` `PEDIA/` `SECRETARY/` `ADMIN/` `SIGN-UP,LOGIN/` | HTML pages for each role |
| `js/<role>/` | Each page's script (for example `js/parent/screening.js`) |
| `CSS files/` | Stylesheets, served at `/css`. Colour tokens are in `kc-tokens.css` |
| `ICONS/` | PNG icons, served at `/icons` |
| `ml/` | Dataset generator, trainer, predictor and Python tests |
| `scripts/` | Migrations, seeds and backfills. These write to live data, so run them with `--dry-run` first |
| `tests/unit/` | Offline Node `assert` tests (`npm test`) |
| `docs/` | Design notes (see below) |

## Objective 1: Developmental assessment tool
- `constants/assessmentDomains.js:22` defines the four domains: Communication, Social Skills, Cognitive and Motor Skills.
- `js/parent/screening.js` (page `PARENT/screening.html`):
  - `DOCTOR_QUESTION_BANK` :7, `buildQuestionSet` :129 (filters questions by age), `getAnswerPayload` :162.
  - `completeAssessment` :433 posts the answers to `/api/assessments/submit`.
- `routes/assessments.js`:
  - `scoreAnswer` :117 (Yes = 2, Sometimes = 1, No = 0).
  - `POST /initialize` :635, `/save-draft` :695, `/submit` :745. Inside `/submit`, the domain totals are at :797, the percentages at :952–956, the risk flags at :958 and the save at :980.
- `constants/scoring.js`: the 80/60/40 bands at :69–74, `bandFor` :152, `isRiskFlagged` :193.
- Models: `CoreBankQuestion`, `AssessmentAnswer`, `AssessmentResult`, `Assessment`.

## Objective 2: Progress-tracking dashboard
- `routes/parent-reports.js:101` serves `GET /api/parent/children/:childId/report`, the timeline of completed assessments with per-domain scores.
- `services/assessmentProgress.js`: `compareAssessmentProgress` :344, `buildScoreChanges` :373, `buildAssessmentProgressSummary` :407 (used by `GET /api/assessments/:id/compare` at `routes/assessments.js:1849`).
- `js/parent/reports.js` (page `PARENT/reports.html`): `renderTrend` :225, `drawTrendChart` :292, `renderLatestDomains` :359.
- `js/parent/dashboard.js` (page `PARENT/dashboard.html`): `loadDashboard` :88 loads the assessment history and recommendations; `renderSkills` :176.
- Home-activity completion: `Recommendation.completedActivities` (`models/Recommendation.js:19`), and `buildActivityProgress` (`routes/recommendations.js:140`).
  - `PATCH /api/recommendations/:recommendationId/activities` (:419) lets the parent or a permitted guardian mark an activity done or undo it.
  - Checkboxes are in `js/parent/recommendations.js` (`toggleActivity` :331). The dashboard bar is `renderActivityProgress` (`js/parent/dashboard.js:224`).
  - Tested by `tests/unit/activity-completion.test.js`.
- Developmental task scheduling: `models/ActivitySchedule.js` (one session per Manila date and time, Pending/Completed/Missed, optional 0–100% score).
  - Routes in `routes/recommendations.js`: `POST /:recommendationId/schedule`, `PATCH` and `DELETE /schedule/:taskId`, plus `scheduledTasks` on `GET /:assessmentId`. Missed is derived once a pending session's day has passed, and completing a session also ticks the activity.
  - Reminders come from `activityReminders` in `services/reminders.js` (the daily cron). The UI is the Upcoming Activities card and the per-activity sessions in `js/parent/recommendations.js`.
  - Tested by `tests/unit/activity-scheduling.test.js`.

## Objective 3: Automated recommendations
- `routes/recommendations.js`:
  - `RECOMMENDATION_LEVEL_BY_BAND` :62, `buildRecommendationSet` :69, `buildOverallCarePlan` :162, `buildSuggestedPediatricians` :250.
  - `GET /:assessmentId` :297 generates the recommendations and saves them once (:330–339). It also returns `completedActivities` and `activityProgress`.
- `services/assessmentProgress.js`: `buildPredictionForStorage` :254 uses the ML prediction when available and falls back to rule-based staging otherwise.
- `constants/developmental-staging.js`: `getCareStageFromScore` :182, `getCarePlanForCareStage` :126.
- `models/Recommendation.js` (skill, priority, suggestion, activities, consultationNeeded).
- Displayed on `PARENT/recommendations.html` (`js/parent/recommendations.js`) and on the dashboard.

## Objective 4: Pediatric appointment booking
- `js/parent/appointments.js` (page `PARENT/appointments.html`): `bookAppointment` :579 posts to `/api/appointments/create`. Availability is checked at :518 and the pediatrician list is loaded at :546.
- `routes/appointments.js`:
  - `evaluateAvailability` :745 (working days, hours, breaks, daily capacity, overlapping bookings).
  - `buildIntervalSlots` :425, `intervalsOverlap` :381, `validateRequestedTime` :469.
  - `GET /pediatricians/list` :1323, `GET /availability/check` :1357, `POST /create` :1477.
  - `PUT /:id/status` :1687, `POST /:id/cancel` :1782, `POST /:id/reschedule` :1809.
- `models/Appointment.js`.
- After booking, payment happens separately on `PARENT/payment.html` (`routes/payments.js`, `services/paymentService.js`).

## Existing documentation
- `CLAUDE.md`: commands, architecture and conventions.
- `docs/SCORING.md`: scoring protocol. The band cutoffs have not been clinically validated yet.
- `docs/PEDIA-REPORTS.md`, `docs/synthetic-data-and-model-pipeline.md`, `docs/AUDIT-SUMMARY.md`, and the `docs/dataset-questions-*.md` notes.
- `ml/datasets/README.md`: the ML dataset.
- `graphify-out/GRAPH_REPORT.md`: a generated knowledge graph of the code.
- `README.md` and `READ THESE GUIDES JUSKOLORD/HOW_TO_RUN.txt` are outdated. HOW_TO_RUN.txt still describes SQL Server.
