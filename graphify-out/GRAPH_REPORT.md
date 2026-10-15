# Graph Report - KinderCura-Updated-File  (2026-10-15)

## Corpus Check
- 316 files · ~414,498 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 75 file(s) not represented in the graph (top: .css 45, .bson 24, (none) 3)

## Summary
- 4221 nodes · 8357 edges · 185 communities (173 shown, 12 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 493 edges (avg confidence: 0.85)
- Token cost: 311,445 input · 0 output

## Community Hubs (Navigation)
- Signup & OTP Auth UI
- Pedia Patients Page
- Appointment Routes & SSE
- Admin API Routes
- Admin Analytics Interpretations
- Parent Custom Questions & Nav
- Dataset Question Assessment Tests
- Admin Data Sources Page
- Admin Insights Page
- Parent Appointment Booking
- Auth Routes & SMTP
- React Guardian Pages
- PRC License Verification
- Guardian Controller
- Admin Training Page
- Assessment Routes & Notifications
- ML Model Manager
- System Demo Data Generator
- ML Admin Routes & Activation
- Specialist Referral Tests
- Admin Reports Page
- Parent Report Interpretations
- Parent Results Page
- Checkup & Referral Routes
- Pedia Report Interpretations
- Payment Controller
- Pedia Dashboard & Reschedule
- Pedia Appointments Page
- ML Preprocessing Pipeline
- Custom Questions & Domains
- Parent-Pedia Chat
- Pedia Reports Page
- Pedia Reschedule Tests
- Trainer Validation Tests (Py)
- npm Scripts
- Admin Reports Aggregations
- Pedia Question Set Assignment
- Clinic Payment QR Tests
- Shared API Client (api.js)
- File Storage Service
- Parent Screening Flow
- Admin Patient Reports View
- Python Model Trainer
- Email Service
- Dataset Questions Seeding
- Synthetic Data Constants
- Guardian Access & Parent Reports
- Dataset Generator (Py)
- Admin Reports Interpretations
- Parent Recommendations Page
- Appointment Video Routes
- Notification Route Tests
- Signup Consent Tests
- Parent Reports Page
- Payment Service
- Admin Analytics Page
- Chat Routes & Guardian Permission
- Pedia Checkup Tests & Audit
- Guardian Link Tests
- Pedia Demo Seed & Assignment Guard
- Pedia Reports Routes & CSV
- Assessment Progress & Care Stage
- Express Server Bootstrap
- Signup Required-Fields Tests
- Data Origin & Question Models
- Scoring Bands & Risk Flags
- DB Connection & Migrations
- Developmental Staging
- Receipts & PayMongo Webhook
- Core Mongoose Models
- User Model & Admin Seed
- Reviewed-Label ML Training Tests
- PayMongo Billing Tests
- Pedia Assign Modal Tests
- PayMongo Checkout Service
- Dataset Quality Gate
- Notifications Routes
- ML-Backed Assessment Generator
- ML Prediction (Py)
- Parent Guardian Management (JS)
- Admin Pages & Dataset Pipeline UI
- Parent Dashboard
- Parent Payment Page
- Secretary Approval Queue
- Upload Routes
- Guardian Invitation Logic
- Child Age Tests
- Synthetic User Profile Improver
- R2 Object Store Client
- Admin Training Display
- Pedia Question Submissions View
- Shared Care-Plan Labels
- Auth Middleware & Child Routes
- Admin Metrics & Export Tests
- R2 Artifact & Backup
- Pediatrician Suggestions
- Synthetic Plan RNG
- Core Bank Question Seeding
- Admin Data Source View
- Runtime Dependencies (multer, qrcode)
- Synthetic Identities
- Parent Profile Page
- Pedia Assignment Tracker
- Pedia Bulk Assign Dialog
- Secretary Cashier & QR Scan
- ML Production Flow Tests
- R2 File Storage Tests
- Audit Logs & Guardian Links
- Scoring Bands Backfill
- Admin User Management
- ML Deployment Bridge Tests
- ML Feature Compatibility Tests
- Training Dataset & ML Client Tests
- Accept Invitation (React inline)
- Secretary Routes
- Dataset Pipeline Service
- Progression Interpretation Tests
- Payment Monitoring & Cashier
- Dataset Questions Review Docs
- Pedia Profile Page
- Secretary Appointments Page
- Dataset Question Packet Builder
- Notification UI Tests
- Python Train Endpoint
- Pedia Settings & Staff
- KC Poll Tests
- HTTP Email Provider
- Signup OTP Tests
- Synthetic Data & Model Docs
- Secretary Patients Page
- Core npm Dependencies
- API Smoke Test & ML Label Review
- Prediction Persistence
- Dataset Question Approval Script
- Admin Dashboard Metrics
- Secretary Dashboard
- Shared Child Age Utils
- Appointment Model & Slot Migration
- Dataset Status Migration Script
- Admin Dashboard Page
- Canonical Dataset Tests (Py)
- Diagnosis Mode Computation
- Legacy routes/api.js Client
- Dataset Question Eligibility
- Scoring Protocol & Backfill Docs
- Parent Family Accounts
- Pedia Create Question Modal
- Appointment & Settings Pages
- Parent Results Wording
- Custom Question Domain Migration
- Static Cache Header Tests
- Permission Sets & Child Migration
- Answer Origin Backfill
- Pedia Collection Rename Migration
- Page Route Traversal Tests
- Secretary Pages & Slot Rules
- Assessment Models
- Audit Summary & Migration Docs
- Admin Slot Settings
- Vercel Deployment Config
- How-To-Run & Env Setup Docs
- Model Schema Tests
- Pedia Reports Module Docs
- Progression Interpretation
- Admin Nav
- ML Validation Safeguards Docs
- Guardian Link Migration
- Rule-Based Screening Concepts
- Item Scoring Formula Docs
- Synthetic Data Safety Docs
- OTP Code Model
- Pediatrician Checkup Model
- Notification Model
- Email Test Script
- Fake Response Test Helper
- Specialist Referral Model
- DNS Preload
- Checkup Shape Helpers
- Admin Loader Test Stubs
- Placeholder README

## God Nodes (most connected - your core abstractions)
1. `mongoose` - 61 edges
2. `connectDB()` - 39 edges
3. `scripts` - 34 edges
4. `byId()` - 32 edges
5. `run()` - 30 edges
6. `express` - 27 edges
7. `run()` - 24 edges
8. `GuardianManagement()` - 23 edges
9. `authMiddleware()` - 23 edges
10. `run()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `Answer Encoding (2/1/0, blank = not administered)` --semantically_similar_to--> `Three-Point Item Scoring (yes 2 / sometimes 1 / no 0)`  [INFERRED] [semantically similar]
  ml/datasets/README.md → docs/SCORING.md
- `Model Dataset Pipeline (Generate & Clean)` --conceptually_related_to--> `Optional Machine Learning Consent`  [AMBIGUOUS]
  ADMIN/admin-data-sources.html → SIGN-UP,LOGIN/legal/KINDERCURA-TERMS-OF-SERVICE.txt
- `Settings Page (Pediatrician)` --semantically_similar_to--> `Settings Page (Parent)`  [INFERRED] [semantically similar]
  PEDIA/pediatrician-settings.html → PARENT/settings.html
- `Staff Access Tab (Assistant/Secretary Management)` --semantically_similar_to--> `Family Management Section (Linked Guardians / Add Family Member)`  [INFERRED] [semantically similar]
  PEDIA/pediatrician-settings.html → PARENT/settings.html
- `Root Python Dependencies (scikit-learn, pandas, joblib, numpy)` --semantically_similar_to--> `ML Python Dependencies (scikit-learn, pandas, joblib)`  [INFERRED] [semantically similar]
  requirements.txt → ml/requirements.txt

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Registration and Consent Flow** — sign_up_login_landing, sign_up_login_signup, sign_up_login_signup_continuetoconsent, sign_up_login_signup_terms_consent_modal, sign_up_login_legal_kindercura_terms_of_service, sign_up_login_verify_email, sign_up_login_login [INFERRED 0.85]
- **ML Dataset Generation, Training and Activation Pipeline** — admin_admin_data_sources_model_dataset_pipeline, admin_admin_training_dataset_readiness, admin_admin_training_stratified_split, admin_admin_training_model_activation_modal, ml_pipeline, ml_trainer [INFERRED 0.85]
- **Clinic Payment Collection and Monitoring** — secretary_secretary_cashier_pay_at_clinic_qr, admin_admin_payments_loadpaymentmonitor, admin_admin_payments_viewreceipt, routes_payments [INFERRED 0.85]
- **Pages loading constants/scoring.js (window.KCScoring) before their page script** — parent_dashboard, parent_recommendations, parent_reports, parent_results, pedia_pedia_questions, pedia_pedia_reports, pedia_pediatrician_dashboard, pedia_pediatrician_patients, constants_scoring [EXTRACTED 1.00]
- **Guardian invitation, permissions and family management flow** — parent_accept_invitation_acceptinvitation, parent_accept_invitation_guardian_invitation_api, parent_accept_invitation_guardian_permissions, parent_guardian_management, parent_settings_family_management, parent_guardian_management_transfer_primary_guardian [INFERRED 0.85]
- **Appointment booking, scheduling and payment flow** — parent_appointments, parent_payment, parent_payment_paymongo_online_payment, parent_payment_pay_at_clinic_qr, pedia_pediatrician_appointments, pedia_pediatrician_dashboard_reschedule_dialog, pedia_pediatrician_settings_availability [INFERRED 0.85]
- **Rule-Based Scoring Pipeline (item -> domain % -> overall -> band/flag)** — docs_scoring_item_scoring, docs_scoring_domain_percentage, docs_scoring_overall_unweighted_mean, docs_scoring_active_bands, docs_scoring_risk_flag_threshold [EXTRACTED 1.00]
- **Dataset Question Activation Blockers** — docs_dataset_questions_open_issues_age_gating_blocker, docs_dataset_questions_open_issues_sometimes_undefined, docs_dataset_questions_open_issues_missing_items, docs_dataset_questions_open_issues_parent_output_constraints, docs_dataset_questions_open_issues_licence_confirmation, docs_dataset_questions_open_issues_translation [EXTRACTED 1.00]
- **Safeguards Against Invalid ML / Validation Claims** — docs_audit_summary_ml_claim_prerequisites, docs_pedia_reports_no_validation_metrics, ml_datasets_readme_real_labels_requirement, ml_datasets_readme_label_noise_leakage_avoidance, docs_audit_summary_clinical_outcome_field [INFERRED 0.85]

## Communities (185 total, 12 thin omitted)

### Community 0 - "Signup & OTP Auth UI"
Cohesion: 0.06
Nodes (75): Philippines Compliance Settings, existingToken, existingUser, backToCredentials(), byId(), canLeaveStep(), checkStep(), childDobError() (+67 more)

### Community 1 - "Pedia Patients Page"
Cohesion: 0.06
Nodes (69): _allPatients, apiFetch(), aptStatusBadge(), assessmentDateLabel(), calcAge(), cancelAddCheckup(), cancelReferral(), checkupStatusMeta() (+61 more)

### Community 2 - "Appointment Routes & SSE"
Cohesion: 0.06
Nodes (61): Appointment, Assessment, ASSESSMENT_DOMAINS, AssessmentResult, { authMiddleware, secretaryOrPediatrician }, buildExistingAppointmentIntervals(), buildIntervalSlots(), buildSuggestedPediatricians() (+53 more)

### Community 3 - "Admin API Routes"
Cohesion: 0.04
Nodes (49): {
  ADMIN_CATEGORY,
  ADMIN_CATEGORY_VALUES,
  sortByDate,
  paginate,
  filterDatasetRows,
  filterPediatricianRows,
  summarizePediatricians,
  countAssignedChildrenByPediatrician,
  attachAssignedChildCounts,
  groupDatasetSources,
}, ageMonthsAt(), Appointment, Assessment, AssessmentAnswer, AssessmentResult, AuditLog, { authMiddleware, adminOnly } (+41 more)

### Community 4 - "Admin Analytics Interpretations"
Cohesion: 0.07
Nodes (51): computeCompletionRate(), computeMonitoringSummary(), computeSignupChange(), formatCount(), formatDomainInterpretation(), formatHistogramInterpretation(), formatList(), isCount() (+43 more)

### Community 5 - "Parent Custom Questions & Nav"
Cohesion: 0.08
Nodes (49): allChildren, buildAnswerInput(), changeChildFilter(), clearSetAnswers(), encodeJsString(), esc(), flash(), getAssignmentGroupKey() (+41 more)

### Community 6 - "Dataset Question Assessment Tests"
Cohesion: 0.07
Nodes (51): approvalStatusLabel(), setDatasetQuestionActivation(), activate(), activationTests(), { adminOnly }, adminRouter, Appointment, assert (+43 more)

### Community 7 - "Admin Data Sources Page"
Cohesion: 0.10
Nodes (52): activationControl(), answerReconciliation(), APPROVAL_LABELS, approvalCell(), buildTableHead(), CATEGORY_LABELS, categoryBadge(), changePage() (+44 more)

### Community 8 - "Admin Insights Page"
Cohesion: 0.11
Nodes (53): activePresetKey(), ageBandLabel(), allZero(), annotateGuardianReconciliation(), applyFilters(), applyPreset(), axisTitle(), bandChip() (+45 more)

### Community 9 - "Parent Appointment Booking"
Cohesion: 0.09
Nodes (50): activeAppointments, allChildren, allPediatricians, applyAppointmentSlotSettings(), applyTimeFieldConstraints(), appointmentSlotSettings, availabilitySummary(), bookAppointment() (+42 more)

### Community 10 - "Auth Routes & SMTP"
Cohesion: 0.04
Nodes (38): Assessment, { authMiddleware }, bcrypt, Child, childAge, EMAIL_PASS, EMAIL_USER, emailConfigured() (+30 more)

### Community 11 - "React Guardian Pages"
Cohesion: 0.09
Nodes (46): Guardian React Client Pages (GuardianManagement, AcceptInvitation), Guardian Invitation API (/api/v2/guardians), JWT Bearer Auth via localStorage token, AcceptInvitation(), authErrorToast(), fetchWithTimeout(), getToken(), handleAuthFailure() (+38 more)

### Community 12 - "PRC License Verification"
Cohesion: 0.06
Nodes (46): Admin PRC License Verification Page, PRC Verification Modal (Bootstrap), buildPrcDocumentCandidates(), capitalize(), esc(), fetchVerifications(), formatDate(), handleUrlParams() (+38 more)

### Community 13 - "Guardian Controller"
Cohesion: 0.09
Nodes (46): isAffirmative(), parseSignupConsent(), createLog(), acceptInvitation(), acceptWithNewAccount(), assertPrimaryOrAdmin(), bcrypt, checkInviteRateLimit() (+38 more)

### Community 14 - "Admin Training Page"
Cohesion: 0.10
Nodes (43): categoryLabel(), cleaningDefinitions(), closeActivationModal(), confirmActivation(), datasetIsReady(), deactivateModel(), deleteDataset(), displayDatasetName() (+35 more)

### Community 15 - "Assessment Routes & Notifications"
Cohesion: 0.05
Nodes (38): Appointment, Assessment, AssessmentAnswer, assessmentProgress, AssessmentResult, AuditLog, { authMiddleware }, buildDiagnosisNotificationMessage() (+30 more)

### Community 16 - "ML Model Manager"
Cohesion: 0.09
Nodes (39): artifactStatus(), buildRemoteTrainingPayload(), buildSmokeTestProbe(), checkRemoteEndpoint(), ensureModelDir(), fileStorage, formatMB(), fs (+31 more)

### Community 17 - "System Demo Data Generator"
Cohesion: 0.06
Nodes (43): assertAppointmentIdsAvailable(), assertNoRealCollisions(), syntheticOnlyFilter(), ANSWER_POINTS, ANSWER_PROBS, Appointment, APPOINTMENT_REASONS, APPOINTMENT_STATUS_MIX (+35 more)

### Community 18 - "ML Admin Routes & Activation"
Cohesion: 0.06
Nodes (40): adminOnly(), mongoose, trainedModelSchema, { authMiddleware, adminOnly }, express, fileStorage, getModelActivationBlocker(), modelLifecycleState() (+32 more)

### Community 19 - "Specialist Referral Tests"
Cohesion: 0.09
Nodes (41): Appointment, assert, Assessment, AuditLog, authorizationTests(), chain(), Child, clone() (+33 more)

### Community 20 - "Admin Reports Page"
Cohesion: 0.11
Nodes (37): changePatientReportsPage(), DEMO_COLLECTION_LABELS, escapeHtml(), fmtCountR(), fmtDateShortPR(), fmtDateTimePR(), fmtReportDate(), GENDER_DISPLAY_LABELS (+29 more)

### Community 21 - "Parent Report Interpretations"
Cohesion: 0.12
Nodes (39): describeDomainHighlights(), formatDate(), formatDomainList(), getAssessmentInterpretation(), getBaselineInterpretation(), getDomainInterpretation(), getHistoryInterpretation(), getTrendInterpretation() (+31 more)

### Community 22 - "Parent Results Page"
Cohesion: 0.11
Nodes (38): allChildren, answerLabel(), BAND_TONE, comparisonRow(), diffColor(), diffText(), domainChipMarkup(), domainStateFromResults() (+30 more)

### Community 23 - "Checkup & Referral Routes"
Cohesion: 0.12
Nodes (40): Appointment, Assessment, AuditLog, { authMiddleware }, buildCheckupNotificationMessage(), Child, createCheckupRecord(), createReferralRecord() (+32 more)

### Community 24 - "Pedia Report Interpretations"
Cohesion: 0.10
Nodes (39): formatActivityInterpretation(), formatDomainBandInterpretation(), formatDomainCountSentences(), formatList(), formatMonthLabel(), formatMovementDescription(), formatOverallBandInterpretation(), formatPatientProgressionInterpretation() (+31 more)

### Community 25 - "Payment Controller"
Cohesion: 0.07
Nodes (34): Appointment, canAccessAppointment(), Child, confirmClinicPayment(), confirmWalkIn(), fileStorage, fs, fullName() (+26 more)

### Community 26 - "Pedia Dashboard & Reschedule"
Cohesion: 0.11
Nodes (35): apiFetch(), APPT_LEGEND, closeReschedule(), escapeHtml(), fmt(), fmtDate(), fmtTime(), getToken() (+27 more)

### Community 27 - "Pedia Appointments Page"
Cohesion: 0.13
Nodes (33): apiFetch(), appointmentSlotSettings, badge(), cancelConfirm(), closeModal(), confirmReschedule(), confirmStatus(), currentPediatricianId() (+25 more)

### Community 28 - "ML Preprocessing Pipeline"
Cohesion: 0.08
Nodes (14): Cleaning Report Reconciliation (50,179 - 217 - 651 = 49,311), Requirement B: 50,000-Record Model Dataset, dataset_version(), print_human_summary(), run_pipeline(), clean_dataframe(), CleaningError, _encode_answer_cell() (+6 more)

### Community 29 - "Custom Questions & Domains"
Cohesion: 0.07
Nodes (32): ASSESSMENT_DOMAINS, isValidNewDomain(), LEGACY_DOMAIN_MAP, normalizeDomain(), { ASSESSMENT_DOMAINS, FALLBACK_DOMAIN, normalizeDomain }, Counter, { DATA_ORIGIN }, mongoose (+24 more)

### Community 30 - "Parent-Pedia Chat"
Cohesion: 0.10
Nodes (25): chatFetch(), clearAttach(), handleKey(), loadMessages(), loadThreads(), openThread(), pollMessages(), renderMessages() (+17 more)

### Community 31 - "Pedia Reports Page"
Cohesion: 0.17
Nodes (32): applyFilters(), bandChip(), bandKeys(), clearFilters(), count(), currentRangeQuery(), deltaHtml(), DOMAINS (+24 more)

### Community 32 - "Pedia Reschedule Tests"
Cohesion: 0.06
Nodes (26): Appointment, assert, call(), check, Child, childId, makeAppt(), doc (+18 more)

### Community 33 - "Trainer Validation Tests (Py)"
Cohesion: 0.12
Nodes (17): run_predict(), run_trainer(), test_trainer_accepts_canonical_dataset_and_predictor_matches(), run(), run_predict(), run_trainer(), test_blank_labels_rejected(), test_data_leakage_prevented() (+9 more)

### Community 34 - "npm Scripts"
Cohesion: 0.06
Nodes (34): scripts, approve:dataset-questions, approve:dataset-questions:dry, backfill:answer-origin, backfill:answer-origin:dry, backfill:scoring-bands, backfill:scoring-bands:apply, backfill:scoring-bands:dry (+26 more)

### Community 35 - "Admin Reports Aggregations"
Cohesion: 0.06
Nodes (22): AGE_BAND_KEYS, AGE_BANDS, Assessment, AssessmentResult, { authMiddleware, adminOnly }, BAND_KEYS, bandStageExpr(), Child (+14 more)

### Community 36 - "Pedia Question Set Assignment"
Cohesion: 0.08
Nodes (23): allQuestions, allQuestionSets, ASSIGN_DOMAINS, assignDateCell(), assignDomainScoreCell(), assignmentStatusFor(), assignScoreBadge(), assignScoresByChild (+15 more)

### Community 37 - "Clinic Payment QR Tests"
Cohesion: 0.08
Nodes (31): Appointment, assert, chain(), Child, controller, fakeReq(), fs, handlerTests() (+23 more)

### Community 38 - "Shared API Client (api.js)"
Cohesion: 0.09
Nodes (17): apiFetch(), applyNavUser(), applyNotificationContext(), fetchParentChildren(), getLatestCompletedAssessment(), getNotificationBadge(), highlightActiveNavLink(), initNav() (+9 more)

### Community 39 - "File Storage Service"
Cohesion: 0.09
Nodes (28): serveProofImage(), loadDatasetContent(), safeRemoveUpload(), movePrcUploadToUserFile(), moveProfileUploadToUserFile(), uploadPathExists(), probeObjectStorage(), deletePrcFile() (+20 more)

### Community 40 - "Parent Screening Flow"
Cohesion: 0.12
Nodes (29): answers, buildCustomAnswerOptions(), buildFullSet(), buildQuestionSet(), completeAssessment(), CUSTOM_QUESTION_SET, difficultyRank(), DOCTOR_QUESTION_BANK (+21 more)

### Community 41 - "Admin Patient Reports View"
Cohesion: 0.10
Nodes (27): Appointment, Assessment, AssessmentResult, { authMiddleware, adminOnly }, Child, COL, express, fullName() (+19 more)

### Community 42 - "Python Model Trainer"
Cohesion: 0.12
Nodes (10): encode_question_value(), fail(), load_dataset(), prepare_features(), prepare_question_features(), prepare_score_features(), train(), train_dataframe() (+2 more)

### Community 43 - "Email Service"
Cohesion: 0.16
Nodes (29): acceptUrlFor(), actionButton(), appUrl(), brandLine(), buildPermissionBlock(), childCardsHtml(), childTag(), deliver() (+21 more)

### Community 44 - "Dataset Questions Seeding"
Cohesion: 0.12
Nodes (25): GENERATION_METHOD, { APPROVAL_STATUS, GENERATION_METHOD }, DATASET_QUESTIONS, DATASET_REVIEW, DATASET_SOURCES, SCORING_DOMAINS, toQuestionDoc(), assertNoOriginCollision() (+17 more)

### Community 45 - "Synthetic Data Constants"
Cohesion: 0.10
Nodes (24): crypto, RFC-2606, mongoose, SYNTHETIC_ONLY_FILTER, syntheticAppointmentId(), syntheticAppointmentSlice(), syntheticEmail(), syntheticObjectId() (+16 more)

### Community 46 - "Guardian Access & Parent Reports"
Cohesion: 0.08
Nodes (24): selectPaymentMode(), checkPermission(), Child, GuardianLink, hasPermission(), resolveChildIdFromReq(), childSchema, mongoose (+16 more)

### Community 47 - "Dataset Generator (Py)"
Cohesion: 0.14
Nodes (14): app_round(), fieldnames(), generate_dataset(), generate_row(), inject_defects(), main(), observation_key(), sample_answer() (+6 more)

### Community 48 - "Admin Reports Interpretations"
Cohesion: 0.12
Nodes (27): formatAgeRangeInterpretation(), formatDiagnosisInterpretation(), formatGenderInterpretation(), formatList(), mostFrequentEntries(), plural(), AGE_KEYS, AGE_LABELS (+19 more)

### Community 49 - "Parent Recommendations Page"
Cohesion: 0.13
Nodes (27): allChildren, areaScoreLine(), fetchParentChildren(), getLatestCompletedAssessment(), getRequestedAssessmentId(), getRequestedChildId(), goBookWithPediatrician(), ICONS (+19 more)

### Community 50 - "Appointment Video Routes"
Cohesion: 0.07
Nodes (24): Appointment, appointmentVideoSchema, { authMiddleware }, Child, Counter, express, fileStorage, finalizeAppt (+16 more)

### Community 51 - "Notification Route Tests"
Cohesion: 0.13
Nodes (25): assert, bulkTests(), castFilter(), deleteOneTests(), fakeCollection, fakeRes(), res, handler() (+17 more)

### Community 52 - "Signup Consent Tests"
Cohesion: 0.08
Nodes (26): express, assert, CASES, chain(), clientTests(), css, CSS_PATH, fs (+18 more)

### Community 53 - "Parent Reports Page"
Cohesion: 0.18
Nodes (24): allChildren, checkupStatusMeta(), checkupVisitTypeLabel(), drawTrendChart(), escapeHtml(), fmtAge(), fmtDate(), fmtScheduledDate() (+16 more)

### Community 54 - "Payment Service"
Cohesion: 0.17
Nodes (26): quoteDownPayment(), Appointment, APPOINTMENT_PAYMENT_TYPE, appointmentPaymentTypeFor(), asAmount(), buildDeferredPaymentPlan(), buildInitialPaymentPlan(), buildPaymentSummary() (+18 more)

### Community 55 - "Admin Analytics Page"
Cohesion: 0.15
Nodes (24): APPOINTMENT_STATUS_ORDER, currentUtcMonthKey(), DOMAIN_COLORS, escapeHtml(), histogramBinColor(), initSSE(), loadAnalytics(), renderLegend() (+16 more)

### Community 56 - "Chat Routes & Guardian Permission"
Cohesion: 0.09
Nodes (22): Appointment, Child, GuardianLink, hasPermission(), resolveChildIdFromReq(), chatMessageSchema, mongoose, Appointment (+14 more)

### Community 57 - "Pedia Checkup Tests & Audit"
Cohesion: 0.08
Nodes (25): auditLogSchema, mongoose, Appointment, assert, Assessment, assessmentId, AuditLog, chainable() (+17 more)

### Community 58 - "Guardian Link Tests"
Cohesion: 0.12
Nodes (23): guardianInvitationSchema, mongoose, assert, auditController, chain(), Child, controller, createAccountTests() (+15 more)

### Community 59 - "Pedia Demo Seed & Assignment Guard"
Cohesion: 0.10
Nodes (22): Appointment, Child, { connectDB, mongoose }, { createOverlapTracker, ACTIVE_APPOINTMENT_STATUSES }, { DATA_ORIGIN }, daysAgoDate(), DRY_RUN, findExclusiveChildren() (+14 more)

### Community 60 - "Pedia Reports Routes & CSV"
Cohesion: 0.08
Nodes (16): Appointment, Assessment, AssessmentResult, { authMiddleware }, BAND_KEYS, bandIndex(), bandMovement(), Child (+8 more)

### Community 61 - "Assessment Progress & Care Stage"
Cohesion: 0.11
Nodes (24): Assessment, buildAssessmentProgressSummary(), buildPredictionForStorage(), buildPreviousAssessmentFilter(), buildScoreChanges(), Child, compareAssessmentProgress(), getAssessmentCareStage() (+16 more)

### Community 62 - "Express Server Bootstrap"
Cohesion: 0.10
Nodes (22): app, CACHE_RULES, cacheControlFor(), cachedStatic(), checkExistingServer(), { connectDB, mongoose }, cors, { exec } (+14 more)

### Community 63 - "Signup Required-Fields Tests"
Cohesion: 0.10
Nodes (25): AGE_JS, assert, CHILD, childAge, credentialTests(), DOCTOR, DOCTOR_LOGIN, doctorAt() (+17 more)

### Community 64 - "Data Origin & Question Models"
Cohesion: 0.10
Nodes (19): APPROVAL_STATUS, APPROVAL_STATUS_LABELS, APPROVAL_STATUS_VALUES, DATA_ORIGIN, DATA_ORIGIN_LABELS, DATA_ORIGIN_SOURCE_KIND, DATA_ORIGIN_VALUES, GENERATION_METHOD_LABELS (+11 more)

### Community 65 - "Scoring Bands & Risk Flags"
Cohesion: 0.13
Nodes (22): bandFor(), clinicalLabel(), colorForBand(), colorForScore(), filterOptions(), isRiskFlagged(), normalizeScore(), parentDomainStatus() (+14 more)

### Community 66 - "DB Connection & Migrations"
Cohesion: 0.14
Nodes (18): app, { connectDB, mongoose }, connectDB(), mongoose, { connectDB, mongoose }, TARGETS, { connectDB, mongoose }, isDryRun() (+10 more)

### Community 67 - "Developmental Staging"
Cohesion: 0.10
Nodes (19): CARE_STAGE, CARE_STAGE_DEFINITIONS, CARE_STAGE_RANK, compareCareStages(), DEVELOPMENTAL_BAND_TO_CARE_STAGE, getCareStageFromDevelopmentalBand(), getCareStageFromRiskCategory(), getCareStageFromScore() (+11 more)

### Community 68 - "Receipts & PayMongo Webhook"
Cohesion: 0.11
Nodes (22): findPaymentForWebhookResource(), handlePaymongoWebhook(), notifyPaymentSettled(), appointmentSlotSettingsSchema, clinicSettingsSchema, mongoose, systemSettingSchema, Appointment (+14 more)

### Community 69 - "Core Mongoose Models"
Cohesion: 0.10
Nodes (17): counterSchema, mongoose, Counter, mongoose, patientProgressNoteSchema, Counter, mongoose, paymentSchema (+9 more)

### Community 70 - "User Model & Admin Seed"
Cohesion: 0.09
Nodes (21): availabilitySchema, mongoose, notificationSettingsSchema, privacySettingsSchema, { SYNTHETIC_FIELDS }, userSchema, bcrypt, Appointment (+13 more)

### Community 71 - "Reviewed-Label ML Training Tests"
Cohesion: 0.11
Nodes (23): computeDatasetProvenance(), resolveTrainingQualityGate(), adminRouter, assert, Assessment, AssessmentAnswer, AssessmentResult, chainable() (+15 more)

### Community 72 - "PayMongo Billing Tests"
Cohesion: 0.18
Nodes (23): pickBilling(), readBillingFromWebhookResource(), readSessionOutcome(), resolveReceiptContact(), assert, checkoutSessionWebhookResource(), directPaymentWebhookResource(), paymentIntentWebhookResource() (+15 more)

### Community 73 - "Pedia Assign Modal Tests"
Cohesion: 0.10
Nodes (18): ALL_SCORED, assert, el(), els, footerCount, fs, html(), makeEl() (+10 more)

### Community 74 - "PayMongo Checkout Service"
Cohesion: 0.14
Nodes (22): assertParentMayPay(), assertPayable(), clinicCounterUrl(), ensureAutomatedPayment(), getPaymentStatusByRef(), reconcileCheckout(), resolvePaidBillingAndSource(), startOnlineCheckout() (+14 more)

### Community 75 - "Dataset Quality Gate"
Cohesion: 0.13
Nodes (22): buildReviewedAssessmentQualitySummary(), detectDuplicates(), round2(), summarizeAge(), summarizeClassDistribution(), summarizeMissingness(), summarizeReviewers(), adminRouter (+14 more)

### Community 76 - "Notifications Routes"
Cohesion: 0.16
Nodes (22): { authMiddleware }, buildNotificationQuery(), buildOwnedNotificationQuery(), buildUserQuery(), Child, countUnreadForUser(), deleteManyNotifications(), deleteOneNotification() (+14 more)

### Community 77 - "ML-Backed Assessment Generator"
Cohesion: 0.09
Nodes (22): ANSWER_PROBS, Assessment, AssessmentAnswer, AssessmentResult, Child, CHILD_FIRST_F, CHILD_FIRST_M, { connectDB, mongoose } (+14 more)

### Community 78 - "ML Prediction (Py)"
Cohesion: 0.16
Nodes (6): handler, encode_question_value_for_predict(), fail(), predict(), predict_from_artifact(), PredictionError

### Community 79 - "Parent Guardian Management (JS)"
Cohesion: 0.16
Nodes (20): escapeHtml(), expiryText(), getInitialChildId(), getStoredChildId(), getToken(), getUrlChildId(), gmApi(), grantedLabels() (+12 more)

### Community 80 - "Admin Pages & Dataset Pipeline UI"
Cohesion: 0.13
Nodes (20): Admin Analytics Page, Pediatrician Assessment Comparison, Assessment Score Distribution Histogram, Admin Dashboard Page, Admin Data Sources Page, Model Dataset Pipeline (Generate & Clean), Pediatrician Question Summary, System Demo Data (Read-only) (+12 more)

### Community 81 - "Parent Dashboard"
Cohesion: 0.18
Nodes (20): allChildren, APPT_STATUS_LEGEND, calcAge(), escapeHtml(), fetchParentChildren(), initParentCharts(), loadDashboard(), loadNotifPreview() (+12 more)

### Community 82 - "Parent Payment Page"
Cohesion: 0.25
Nodes (20): appointmentId, backToOptions(), buildSummaryHtml(), clearError(), escapeHtml(), fmtDate(), fmtDateTime(), fmtTime() (+12 more)

### Community 83 - "Secretary Approval Queue"
Cohesion: 0.20
Nodes (19): appointmentTimestamp(), approvals, batchApprove(), canManageBookings(), currentUser, loadApprovals(), permissions, rejectAppointment() (+11 more)

### Community 84 - "Upload Routes"
Cohesion: 0.10
Nodes (17): { authMiddleware }, Child, express, fileStorage, finalizePrc, finalizeProfile, fs, GuardianLink (+9 more)

### Community 85 - "Guardian Invitation Logic"
Cohesion: 0.16
Nodes (19): BOOLEAN_PERMISSION_KEYS, emptyPermissions(), isValidPreset(), isValidRelationship(), MEDICAL_LEVELS, normalizeEmail(), normalizeMedical(), PRESET_GRANTS (+11 more)

### Community 86 - "Child Age Tests"
Cohesion: 0.13
Nodes (16): AGE_JS_PATH, ageTable(), assert, bornAgo(), chain(), childAge, fs, HTML_PATH (+8 more)

### Community 87 - "Synthetic User Profile Improver"
Cohesion: 0.14
Nodes (16): Appointment, assertNoCollisionsWithRealUsers(), Assessment, AssessmentResult, buildChildSurnameOps(), {
  buildSyntheticIdentities,
  syntheticPediatricianBio,
  SYNTHETIC_EMAIL_DOMAIN,
}, Child, { connectDB, mongoose } (+8 more)

### Community 88 - "R2 Object Store Client"
Cohesion: 0.15
Nodes (14): RFC-3986, cfg(), crypto, describe(), EMPTY_SHA256, hmac(), http, https (+6 more)

### Community 89 - "Admin Training Display"
Cohesion: 0.16
Nodes (16): describeCleaning(), formatCount(), isCount(), orderedClasses(), perClassRows(), rejectionLabel(), assert, CLEANING (+8 more)

### Community 90 - "Pedia Question Submissions View"
Cohesion: 0.16
Nodes (19): formatDateTime(), getDomainClass(), getQuestionStats(), getTypeClass(), groupAssignmentsBySetForTracker(), hasAnswer(), normalizeQuestionTypeLabel(), renderAssignmentTracker() (+11 more)

### Community 91 - "Shared Care-Plan Labels"
Cohesion: 0.12
Nodes (9): developmentalBandLabel(), fieldHints(), interpretationLine(), sourceLabel(), Recommendations Page (Parent), My Patients Page (Pediatrician), Check-up / Medical History Modal (longitudinal, specialist referral), Diagnosis Modal (structured outcome + reviewed ML training label) (+1 more)

### Community 92 - "Auth Middleware & Child Routes"
Cohesion: 0.12
Nodes (13): authMiddleware(), jwt, secretaryOrPediatrician(), { authMiddleware }, Child, childAge, express, GuardianLink (+5 more)

### Community 93 - "Admin Metrics & Export Tests"
Cohesion: 0.11
Nodes (15): adminRouter, assert, adminRouter, Appointment, assert, Assessment, AssessmentAnswer, AssessmentResult (+7 more)

### Community 94 - "R2 Artifact & Backup"
Cohesion: 0.15
Nodes (16): { execFileSync }, git(), run(), today(), assert, DATASET, fs, http (+8 more)

### Community 95 - "Pediatrician Suggestions"
Cohesion: 0.13
Nodes (18): Appointment, Assessment, assessmentProgress, AssessmentResult, { authMiddleware }, buildSuggestedPediatricians(), Child, clinicAddressFor() (+10 more)

### Community 96 - "Synthetic Plan RNG"
Cohesion: 0.20
Nodes (13): administeredQuestions(), buildAnswers(), buildPlan(), between(), buildPlan(), buildRuleBasedPrediction(), mulberry32(), pickSignupDate() (+5 more)

### Community 97 - "Core Bank Question Seeding"
Cohesion: 0.16
Nodes (18): AssessmentAnswer, changedFields(), { connectDB, mongoose }, CoreBankQuestion, { DATA_ORIGIN }, extractBankLiteral(), fs, isDryRun() (+10 more)

### Community 98 - "Admin Data Source View"
Cohesion: 0.23
Nodes (17): ADMIN_CATEGORY, ADMIN_CATEGORY_LABELS, ADMIN_CATEGORY_MAP, ADMIN_CATEGORY_VALUES, adminCategoryForOrigin(), attachAssignedChildCounts(), countAssignedChildrenByPediatrician(), DATA_ORIGIN (+9 more)

### Community 99 - "Runtime Dependencies (multer, qrcode)"
Cohesion: 0.11
Nodes (16): { MongoClient }, description, devDependencies, nodemon, main, name, version, cors (+8 more)

### Community 100 - "Synthetic Identities"
Cohesion: 0.18
Nodes (16): isSyntheticEmail(), buildSyntheticIdentities(), crypto, FIRST_NAMES_F, FIRST_NAMES_M, isSyntheticEmailAddress(), RFC-2606, LAST_NAMES (+8 more)

### Community 101 - "Parent Profile Page"
Cohesion: 0.18
Nodes (13): addChild(), apiFetch(), calcAge(), changePassword(), field(), initNav(), KC, loadProfile() (+5 more)

### Community 102 - "Pedia Assignment Tracker"
Cohesion: 0.22
Nodes (18): apiFetch(), assignRowAction(), assignSetToPatient(), assignToPatient(), assignToSelectedPatients(), closeAssignModal(), deleteQuestion(), editQuestionInSet() (+10 more)

### Community 103 - "Pedia Bulk Assign Dialog"
Cohesion: 0.21
Nodes (18): assignRowFromAssessment(), assignVisibleRows(), clearAssessmentFilters(), filterPatientsByAssessment(), isAssignable(), loadAssignScores(), loadPatientsOnly(), openAssignDialog() (+10 more)

### Community 104 - "Secretary Cashier & QR Scan"
Cohesion: 0.23
Nodes (17): clearScanError(), confirmPayment(), escapeHtml(), fmtDate(), fmtTime(), formatMoney(), loadToday(), loginUrlForThisPage() (+9 more)

### Community 105 - "ML Production Flow Tests"
Cohesion: 0.18
Nodes (16): assert, fs, http, installMemoryModels(), matches(), listen(), os, path (+8 more)

### Community 106 - "R2 File Storage Tests"
Cohesion: 0.20
Nodes (16): assert, crypto, fakeRes(), freshFileStorage(), fs, http, path, REPO_ROOT (+8 more)

### Community 107 - "Audit Logs & Guardian Links"
Cohesion: 0.12
Nodes (14): LINK_ROLES, RELATIONSHIPS, AuditLog, listLogs(), Child, guardianLinkSchema, { LINK_ROLES, RELATIONSHIPS }, mongoose (+6 more)

### Community 108 - "Scoring Bands Backfill"
Cohesion: 0.15
Nodes (16): getStatus(), AssessmentResult, BACKUP_DIR, buildReport(), DOCS_DIR, DOMAINS, fs, main() (+8 more)

### Community 109 - "Admin User Management"
Cohesion: 0.18
Nodes (12): approveUser(), createSecretary(), debounceFilter(), linkSecretary(), loadSecretaries(), loadUsers(), pediaOptions, rejectUser() (+4 more)

### Community 110 - "ML Deployment Bridge Tests"
Cohesion: 0.18
Nodes (16): checkPythonEnvironment(), isRemoteML(), assert, CANONICAL_DATASET, createPythonHttpServer(), fileStorage, fs, http (+8 more)

### Community 111 - "ML Feature Compatibility Tests"
Cohesion: 0.15
Nodes (16): isModelCompatible(), buildOverallCarePlan(), assert, CANONICAL_DATASET, FORBIDDEN_FEATURES, fs, modelManager, path (+8 more)

### Community 112 - "Training Dataset & ML Client Tests"
Cohesion: 0.14
Nodes (13): mongoose, trainingDatasetSchema, jsonwebtoken, assert, http, run(), startMockR2(), assert (+5 more)

### Community 113 - "Accept Invitation (React inline)"
Cohesion: 0.15
Nodes (13): abortableFetch(), AcceptInvitation (React component), addToast(), errToState(), getToken(), Guardian Invitation API (/api/v2/guardians verify, accept-invitation, accept-new-account), Guardian Permission Set (PERM_LABEL / REL_LABEL), isExpired() (+5 more)

### Community 114 - "Secretary Routes"
Cohesion: 0.14
Nodes (14): Appointment, { authMiddleware, adminOnly }, bcrypt, Child, defaultPermissions(), express, fullName(), getSecretaryContext() (+6 more)

### Community 115 - "Dataset Pipeline Service"
Cohesion: 0.15
Nodes (16): checkPipelineEnvironment(), DATASET_ACCESS, fileStorage, fs, GENERATED_DIR, generateDataset(), normalizeRowCount(), os (+8 more)

### Community 116 - "Progression Interpretation Tests"
Cohesion: 0.21
Nodes (16): assert, KC, run(), testDirectionWord(), testFormatSignedPoints(), testMissingScores(), testSameScoreSameBand(), testScoreDecreased() (+8 more)

### Community 117 - "Payment Monitoring & Cashier"
Cohesion: 0.23
Nodes (14): Admin Payment Monitoring Page, escapeHtml(), loadPaymentMonitor(), monMethodLabel(), monMoney(), monStatusColor(), renderReceipt(), viewReceipt() (+6 more)

### Community 118 - "Dataset Questions Review Docs"
Cohesion: 0.17
Nodes (15): Dataset Question isActive Approval Guard, CDC Learn the Signs. Act Early., 16 Dataset Questions (DQ01-DQ16), DQ16 Choking/Strangulation Residual Risk, Iles-Caven et al. (2016), Data in Brief 9:112-122, Source Licence Confirmation, Parental Concern & Skill Regression Items, Dataset Questions Open Blocking Issues (+7 more)

### Community 119 - "Pedia Profile Page"
Cohesion: 0.22
Nodes (10): apiFetch(), changePassword(), getToken(), getUser(), loadProfile(), savePersonalInfo(), saveProfInfo(), _u (+2 more)

### Community 120 - "Secretary Appointments Page"
Cohesion: 0.21
Nodes (12): allAppointments, closeReschedule(), confirmWalkIn(), escapeHtml(), filterTab(), fmtDate(), fmtTime(), loadAppointments() (+4 more)

### Community 121 - "Dataset Question Packet Builder"
Cohesion: 0.17
Nodes (15): ageLabel(), bySrc, checklistRows, {
  DATASET_QUESTIONS,
  DATASET_SOURCES,
  DATASET_REVIEW,
}, DOMAIN_ORDER, esc(), fs, NOTES (+7 more)

### Community 122 - "Notification UI Tests"
Cohesion: 0.18
Nodes (15): assert, destinationTests(), fs, loadApi(), ok(), PAGE_DIRS, pagesWithBell(), pageTests() (+7 more)

### Community 124 - "Pedia Settings & Staff"
Cohesion: 0.26
Nodes (12): createSecretary(), escapeHtml(), loadSettings(), loadStaffList(), saveAccountSettings(), saveAvailability(), saveNotificationSettings(), savePrivacySettings() (+4 more)

### Community 125 - "KC Poll Tests"
Cohesion: 0.20
Nodes (11): assert, flush(), fs, loadApi(), env, ok(), path, results (+3 more)

### Community 126 - "HTTP Email Provider"
Cohesion: 0.31
Nodes (14): activeTransport(), deliverOtpEmail(), sendMailWithin(), apiKey(), describe(), httpEmailConfigured(), mailError(), providerName() (+6 more)

### Community 127 - "Signup OTP Tests"
Cohesion: 0.16
Nodes (11): assert, fs, html, httpEmailTests(), mailErrorTests(), noSecretLeakTests(), ok(), path (+3 more)

### Community 128 - "Synthetic Data & Model Docs"
Cohesion: 0.16
Nodes (12): ML Directory Never Operational, Model Activation (Document Gate, Smoke Test, Swap), Model Rollback / Switching, Model v4 Metrics (~63% Accuracy), -1 Not-Administered Sentinel Applied at Train Time, Synthetic Data & Model Pipeline, v1 gender_encoded Model Incompatibility, Answer Encoding (2/1/0, blank = not administered) (+4 more)

### Community 129 - "Secretary Patients Page"
Cohesion: 0.24
Nodes (12): calcAge(), clearFilters(), currentUser, filteredPatients(), loadPatients(), patients, renderPatients(), searchableText() (+4 more)

### Community 130 - "Core npm Dependencies"
Cohesion: 0.14
Nodes (14): dependencies, bcrypt, cors, dotenv, ejs, express, jsonwebtoken, mongodb (+6 more)

### Community 131 - "API Smoke Test & ML Label Review"
Cohesion: 0.18
Nodes (10): rowsToCsv(), getMlLabelValidationError(), HttpError, reviewAssessmentMlLabel(), fs, http, path, requestJson() (+2 more)

### Community 132 - "Prediction Persistence"
Cohesion: 0.19
Nodes (13): getPredictionForResult(), getStoredOrDerivedCareStage(), withConsultationNeeded(), assert, assessmentProgress, AssessmentResult, fakeScores(), modelManager (+5 more)

### Community 133 - "Dataset Question Approval Script"
Cohesion: 0.21
Nodes (13): argValue(), assertNoConflictingDecision(), { connectDB, mongoose }, CoreBankQuestion, { DATA_ORIGIN, APPROVAL_STATUS }, { DATASET_QUESTIONS }, isDryRun(), PEDIATRICIAN_DECISIONS (+5 more)

### Community 134 - "Admin Dashboard Metrics"
Cohesion: 0.22
Nodes (9): buildAssessmentBreakdown(), buildUserDistribution(), share(), toCount(), assert, byKey(), M, run() (+1 more)

### Community 135 - "Secretary Dashboard"
Cohesion: 0.28
Nodes (10): allAppointments, escapeHtml(), fmtDate(), fmtTime(), loadAppointments(), loadProfile(), renderPending(), renderToday() (+2 more)

### Community 136 - "Shared Child Age Utils"
Cohesion: 0.29
Nodes (12): ageInYears(), checkChildAge(), compareDates(), daysInMonth(), eligibleBirthDateRange(), formatDateOnly(), isLeapYear(), localToday() (+4 more)

### Community 137 - "Appointment Model & Slot Migration"
Cohesion: 0.21
Nodes (11): appointmentSchema, Counter, mongoose, { SYNTHETIC_FIELDS }, Appointment, { connectDB, mongoose }, getMode(), minutesToTime() (+3 more)

### Community 138 - "Dataset Status Migration Script"
Cohesion: 0.19
Nodes (12): BACKUP_DIR, buildReport(), DOCS_DIR, fs, main(), mongoose, parseArgs(), path (+4 more)

### Community 139 - "Admin Dashboard Page"
Cohesion: 0.32
Nodes (9): escapeHtml(), formatClock(), loadDashboardData(), renderAssessmentBreakdown(), renderRecentActivity(), renderUserDistribution(), setDashStatus(), setText() (+1 more)

### Community 140 - "Canonical Dataset Tests (Py)"
Cohesion: 0.29
Nodes (6): load_rows(), run(), test_answer_encoding_valid(), test_no_pii_columns(), test_required_assessment_columns_present(), test_risk_category_present_and_valid()

### Community 141 - "Diagnosis Mode Computation"
Cohesion: 0.45
Nodes (11): computeDiagnosisMode(), assert, run(), testBasicMode(), testCaseAndWhitespaceNormalizationMerges(), testDisplayTextNeverRewritten(), testNullOrUndefinedInput(), testSortOrderIsFrequencyDescending() (+3 more)

### Community 142 - "Legacy routes/api.js Client"
Cohesion: 0.20
Nodes (5): fmtDate(), initNav(), KC, loadNotificationCount(), openNotifications()

### Community 143 - "Dataset Question Eligibility"
Cohesion: 0.24
Nodes (9): canActivate(), CoreBankQuestion, { DATA_ORIGIN, APPROVAL_STATUS }, fitsAge(), isApproved(), isUsableInAssessment(), { SCORING_DOMAINS }, selectForAge() (+1 more)

### Community 144 - "Scoring Protocol & Backfill Docs"
Cohesion: 0.27
Nodes (10): Scoring Bands Backfill Report, Band Movement by Band Index, Legacy Band Docs & bandComparabilityWarning, Five Pre-Unification Cutoff Sets, Recommendation Tier & Focus Area Changes, Risk Flag Threshold (<40%), riskLevel/overallRisk Exhaustive Verification, scoringBandsVersion Stamp (v2-80/60/40) (+2 more)

### Community 145 - "Parent Family Accounts"
Cohesion: 0.36
Nodes (9): createFamilyAccount(), FAM_RELATIONSHIP_LABELS, famEscape(), famHeaders(), loadFamilyMembers(), loadFamilyTabData(), populateFamilyChildSelect(), setFamilyMsg() (+1 more)

### Community 146 - "Pedia Create Question Modal"
Cohesion: 0.31
Nodes (11): addOption(), addToBatch(), clearOptions(), closeModal(), onTypeChange(), openCreateModal(), openEditModal(), removeFromBatch() (+3 more)

### Community 147 - "Appointment & Settings Pages"
Cohesion: 0.20
Nodes (11): Appointments Page (Parent), Payment Page (Parent), Pay at Clinic QR / Walk-in Option, PayMongo Online Payment Flow, Settings Page (Parent), Family Management Section (Linked Guardians / Add Family Member), Appointments Page (Pediatrician), Reschedule Appointment Dialog (+3 more)

### Community 148 - "Parent Results Wording"
Cohesion: 0.25
Nodes (9): buildDomainDetails(), buildDomainExplanation(), describeItem(), getScoreThreshold(), getStatus(), interpretAnswer(), scoreAnswer(), assert (+1 more)

### Community 149 - "Custom Question Domain Migration"
Cohesion: 0.22
Nodes (10): { ASSESSMENT_DOMAINS, normalizeDomain }, BACKUP_DIR, fs, main(), mongoose, parseArgs(), path, PediaCustomQuestion (+2 more)

### Community 150 - "Static Cache Header Tests"
Cohesion: 0.22
Nodes (10): app, assert, firstFile(), fs, http, ok(), path, results (+2 more)

### Community 151 - "Permission Sets & Child Migration"
Cohesion: 0.20
Nodes (8): mongoose, permissionSetSchema, permissionsSchema, Child, { connectDB }, GuardianLink, PermissionSet, run()

### Community 152 - "Answer Origin Backfill"
Cohesion: 0.24
Nodes (9): AssessmentAnswer, { connectDB, mongoose }, CoreBankQuestion, { DATA_ORIGIN }, isDryRun(), LEGACY_ORIGIN_VALUES, norm(), PediaCustomQuestion (+1 more)

### Community 153 - "Pedia Collection Rename Migration"
Cohesion: 0.36
Nodes (9): collectionExists(), { connectDB, mongoose }, copyThenDrop(), countOf(), isDryRun(), migrateOne(), MIGRATIONS, run() (+1 more)

### Community 154 - "Page Route Traversal Tests"
Cohesion: 0.24
Nodes (9): app, assert, firstFile(), fs, ok(), path, results, ROOT (+1 more)

### Community 155 - "Secretary Pages & Slot Rules"
Cohesion: 0.25
Nodes (8): Admin System Settings Page, Appointment Slot Rules, Secretary Appointment Management Page, Reschedule Modal, Secretary Appointment Approvals Page, Secretary Dashboard Page, Pending Booking Requests, Secretary Patients Page

### Community 156 - "Assessment Models"
Cohesion: 0.22
Nodes (7): SYNTHETIC_FIELDS, assessmentSchema, mongoose, { SYNTHETIC_FIELDS }, assessmentResultSchema, mongoose, { SYNTHETIC_FIELDS }

### Community 157 - "Audit Summary & Migration Docs"
Cohesion: 0.28
Nodes (9): KinderCura Audit Summary, Banker's Rounding Provenance Finding, D-score / childdevdata, ECDI2030 (UNICEF), Models Trained Counter Correction, Synthetic Demo Fixture Datasets, Dataset Status Migration Report, TrainingDataset status trained -> registered (+1 more)

### Community 158 - "Admin Slot Settings"
Cohesion: 0.28
Nodes (4): loadAppointmentSlotSetting(), saveAppointmentSlotSetting(), setAppointmentSlotSettingState(), _u

### Community 159 - "Vercel Deployment Config"
Cohesion: 0.22
Nodes (8): includeFiles, maxDuration, maxDuration, functions, api/index.js, api/ml_predict.py, api/ml_train.py, routes

### Community 160 - "How-To-Run & Env Setup Docs"
Cohesion: 0.25
Nodes (7): KinderCura Folder Structure (server.js, routes, middleware, role pages), KinderCura v3.0 How To Run Guide, Parent / Pediatrician / Admin Role Portals, SQL Server (SQLEXPRESS02) Legacy Database Setup, /api/health Endpoint, MONGODB_URI Environment Variable, Vercel MONGODB_URI Setup Guide

### Community 161 - "Model Schema Tests"
Cohesion: 0.43
Nodes (7): assert, Assessment, GuardianLink, mongoose, PediatricianCheckup, PermissionSet, run()

### Community 162 - "Pedia Reports Module Docs"
Cohesion: 0.38
Nodes (5): RFC 4180 Screening CSV Export, loadScope() Central Filtering, Pediatrician Reports Module, Overall Score as Unweighted Mean of Domains, Unequal Per-Item Domain Weighting

### Community 164 - "Admin Nav"
Cohesion: 0.53
Nodes (4): ensureDataSourcesNavLink(), ensureInsightsNavLink(), highlightCurrentNav(), initAdminNav()

### Community 165 - "ML Validation Safeguards Docs"
Cohesion: 0.47
Nodes (3): Structured Clinical Outcome Field (clinicalOutcome), Non-Blinded Outcome Labels, Outcome Cross-Tab Removal (2026-09-29)

### Community 166 - "Guardian Link Migration"
Cohesion: 0.40
Nodes (5): Child, { connectDB }, GuardianLink, isDryRun(), run()

### Community 167 - "Rule-Based Screening Concepts"
Cohesion: 0.40
Nodes (4): Dataset Question Age-Gating Blocker, minAgeMonths Item Age Gating, Scores Not Age-Normed, Rule-Based Fallback

### Community 168 - "Item Scoring Formula Docs"
Cohesion: 0.40
Nodes (5): Undefined 'Sometimes' and Missing Scoring/Referral Rules, DQ12 Helper Text Investigation, Display Subdomains (Presentational Only), Domain Percentage Formula, Three-Point Item Scoring (yes 2 / sometimes 1 / no 0)

### Community 169 - "Synthetic Data Safety Docs"
Cohesion: 0.40
Nodes (4): No Fabricated Clinical Judgements in Synthetic Data, Batch-Namespaced syntheticObjectId, Synthetic Pediatrician Booking-List Filter, Requirement A: Synthetic System Demo Data (1,500 users)

### Community 170 - "OTP Code Model"
Cohesion: 0.40
Nodes (4): todayInTimeZone(), mongoose, otpCodeSchema, routeTests()

### Community 171 - "Pediatrician Checkup Model"
Cohesion: 0.40
Nodes (4): mongoose, pediatricianCheckupSchema, STATUSES, VISIT_TYPES

### Community 172 - "Notification Model"
Cohesion: 0.50
Nodes (3): Counter, mongoose, notificationSchema

### Community 173 - "Email Test Script"
Cohesion: 0.50
Nodes (3): nodemailer, nodemailer, transporter

### Community 177 - "Checkup Shape Helpers"
Cohesion: 0.67
Nodes (3): formatPersonName(), shapeCheckup(), shapeReferral()

## Ambiguous Edges - Review These
- `Optional Machine Learning Consent` → `Model Dataset Pipeline (Generate & Clean)`  [AMBIGUOUS]
  ADMIN/admin-data-sources.html · relation: conceptually_related_to
- `Dashboard Page (Parent)` → `Guardian Management Page (Parent)`  [AMBIGUOUS]
  PARENT/dashboard.html · relation: references
- `MONGODB_URI Environment Variable` → `SQL Server (SQLEXPRESS02) Legacy Database Setup`  [AMBIGUOUS]
  READ THESE GUIDES JUSKOLORD/HOW_TO_RUN.txt · relation: conceptually_related_to
- `ML Directory Never Operational` → `Model v4 Metrics (~63% Accuracy)`  [AMBIGUOUS]
  docs/synthetic-data-and-model-pipeline.md · relation: conceptually_related_to
- `Rule-Derived Training Labels (Circular Learning)` → `risk_category Target Label (Low/Medium/High)`  [AMBIGUOUS]
  ml/datasets/README.md · relation: conceptually_related_to

## Knowledge Gaps
- **39 isolated node(s):** `RFC-2606`, `RFC-2606`, `RFC-4180`, `@vercel/blob`, `@vercel/speed-insights` (+34 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 1705 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `mongoose` connect `Core Mongoose Models` to `Appointment Routes & SSE`, `Admin API Routes`, `Dataset Question Assessment Tests`, `Appointment Model & Slot Migration`, `Auth Routes & SMTP`, `Dataset Status Migration Script`, `PRC License Verification`, `Guardian Controller`, `Assessment Routes & Notifications`, `ML Admin Routes & Activation`, `Specialist Referral Tests`, `Custom Question Domain Migration`, `Permission Sets & Child Migration`, `Checkup & Referral Routes`, `Payment Controller`, `Assessment Models`, `Custom Questions & Domains`, `Pedia Reschedule Tests`, `Model Schema Tests`, `Clinic Payment QR Tests`, `Admin Patient Reports View`, `OTP Code Model`, `Pediatrician Checkup Model`, `Notification Model`, `Synthetic Data Constants`, `Guardian Access & Parent Reports`, `Specialist Referral Model`, `Appointment Video Routes`, `Notification Route Tests`, `Payment Service`, `Chat Routes & Guardian Permission`, `Pedia Checkup Tests & Audit`, `Guardian Link Tests`, `Pedia Demo Seed & Assignment Guard`, `Data Origin & Question Models`, `DB Connection & Migrations`, `Receipts & PayMongo Webhook`, `User Model & Admin Seed`, `Notifications Routes`, `Runtime Dependencies (multer, qrcode)`, `ML Production Flow Tests`, `Audit Logs & Guardian Links`, `Scoring Bands Backfill`, `Training Dataset & ML Client Tests`, `Secretary Routes`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **What connects `RFC-2606`, `RFC-2606`, `RFC-4180` to the rest of the system?**
  _39 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Signup & OTP Auth UI` be split into smaller, more focused modules?**
  _Cohesion score 0.059644322845417236 - nodes in this community are weakly interconnected._
- **Why does `Dashboard Page (Parent)` connect `Shared API Client (api.js)` to `Parent Dashboard`, `Scoring Bands & Risk Flags`, `Parent Custom Questions & Nav`, `Accept Invitation (React inline)`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Should `Pedia Patients Page` be split into smaller, more focused modules?**
  _Cohesion score 0.06027306027306027 - nodes in this community are weakly interconnected._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Optional Machine Learning Consent` and `Model Dataset Pipeline (Generate & Clean)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Dashboard Page (Parent)` and `Guardian Management Page (Parent)`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._