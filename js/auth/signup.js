// Signup page helpers for parent and pediatrician onboarding.

let selectedRole = '';

function byId(id) {
    return document.getElementById(id);
}

function valueOf(id) {
    const el = byId(id);
    return el ? String(el.value || '').trim() : '';
}

// Passwords are read exactly as typed: login.js sends the password untrimmed, so
// trimming it here would store a different password from the one used to sign in.
function rawValueOf(id) {
    const el = byId(id);
    return el ? String(el.value || '') : '';
}

function setMessage(id, message) {
    const el = byId(id);
    if (el) el.textContent = message || '';
}

function show(stepId) {
    document.querySelectorAll('.form-step').forEach((step) => {
        step.classList.remove('active');
    });

    const target = byId(stepId);
    if (target) {
        target.classList.add('active');
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function currentRole() {
    const checked = document.querySelector('input[name="role"]:checked');
    selectedRole = checked ? checked.value : selectedRole;
    return selectedRole;
}

function go(step) {
    const role = currentRole();

    if (!role) {
        setMessage('e1', 'Please select a role to continue.');
        return;
    }

    setMessage('e1', '');

    const flow = SIGNUP_FLOWS[role] || SIGNUP_FLOWS.pediatrician;
    const target = flow[step - 1] ? step - 1 : 0;

    // Moving forward: every step before the target must pass its required-field
    // checks, so no call to go() can skip one. Back buttons also call go() but
    // only ever move backwards, which is never blocked.
    if (target > flow.findIndex(isStepActive)) {
        for (let i = 1; i < target; i += 1) {
            if (!canLeaveStep(flow[i])) return;
        }
    }
    show(flow[target]);
}

const SIGNUP_FLOWS = {
    parent: ['s1', 'sp2', 'sp3', 'sp4', 'sp5'],
    pediatrician: ['s1', 'sd2', 'sd3', 'sd4', 'sd5'],
};

// ── Required fields ──────────────────────────────────────────────────────────
// Every field on a step is required unless its label says "(optional)": the
// middle names, the profile pictures and Hospital / Institution have no rule
// here. Each rule returns '' when its field is acceptable, otherwise the message.
const requireText = (id, message) => ({ id, check: () => (valueOf(id) ? '' : message) });
// A <select> left on its placeholder option ("Select gender", ...) has the value ''.
const requireChoice = requireText;

function credentialRules(prefix) {
    const passwordId = `${prefix}Password`;
    return [
        requireText(`${prefix}Username`, 'Please enter a username.'),
        {
            id: `${prefix}Email`,
            check: () => {
                const email = valueOf(`${prefix}Email`);
                if (!email) return 'Please enter your email address.';
                return validateEmail(email) ? '' : 'Please enter a valid email address.';
            },
        },
        {
            id: passwordId,
            check: () => {
                const password = rawValueOf(passwordId);
                if (!password.trim()) return 'Please enter your password.';
                return password.length < 8 ? 'Password must be at least 8 characters long.' : '';
            },
        },
        {
            id: `${prefix}Confirm`,
            check: () => {
                const confirm = rawValueOf(`${prefix}Confirm`);
                if (!confirm.trim()) return 'Please confirm your password.';
                return confirm === rawValueOf(passwordId) ? '' : 'Passwords do not match.';
            },
        },
    ];
}

// Missing, malformed or future dates only. Under 3 / over 8 is validateChildAge()'s
// notice, which runs once every required field on the step is filled in.
function childDobError() {
    const ageRule = window.KCChildAge;
    if (!ageRule) return valueOf('dob') ? '' : "Please enter your child's date of birth.";
    const check = ageRule.checkChildAge(valueOf('dob'));
    return check.ok || check.reason === 'too_young' || check.reason === 'too_old' ? '' : check.message;
}

function licenseExpiryError() {
    const value = valueOf('licenseExpiry');
    if (!value) return 'PRC License Expiry Date is required.';
    const expiry = new Date(value);
    if (Number.isNaN(expiry.getTime())) return 'Please enter a valid PRC License Expiry Date.';
    return expiry <= new Date() ? 'License expiry must be a future date.' : '';
}

const STEP_RULES = {
    sp2: {
        error: 'ep2',
        allMessage: 'Please complete all required fields before continuing.',
        rules: [
            requireText('childFirst', "Please enter your child's first name."),
            requireText('childLast', "Please enter your child's last name."),
            { id: 'dob', check: childDobError },
            requireChoice('childGender', "Please select your child's gender."),
        ],
    },
    sp3: {
        error: 'ep3',
        allMessage: 'Please complete all required fields before continuing.',
        rules: [
            requireText('pFirst', 'Please enter your first name.'),
            requireText('pLast', 'Please enter your last name.'),
            requireChoice('relationship', 'Please select your relationship to the child.'),
        ],
    },
    sp4: {
        error: 'ep4',
        allMessage: 'Please complete all parent login credentials.',
        rules: credentialRules('p'),
    },
    sd2: {
        error: 'ed2',
        allMessage: 'Please complete all required fields before continuing.',
        rules: [
            requireText('dFirst', 'Please enter your first name.'),
            requireText('dLast', 'Please enter your last name.'),
        ],
    },
    sd3: {
        error: 'ed3',
        allMessage: 'Please complete all pediatrician login credentials.',
        rules: credentialRules('d'),
    },
    sd5: {
        error: 'ed5',
        allMessage: 'Please complete all required fields before continuing.',
        rules: [
            { id: 'docIdInput', check: () => (byId('docIdInput')?.files?.[0] ? '' : 'Please upload your PRC ID Card for verification.') },
            requireText('license', 'PRC License Number is required.'),
            requireText('clinicName', 'Please enter your clinic name.'),
            requireText('clinicAddress', 'Please enter your clinic address.'),
            {
                id: 'pediaPhone',
                check: () => {
                    // Same rule routes/auth.js applies on /register.
                    const phone = valueOf('pediaPhone').replace(/[\s-]/g, '');
                    if (!phone) return 'Phone number is required.';
                    return /^(09|\+639)\d{9}$/.test(phone) ? '' : 'Please enter a valid Philippine mobile number (e.g., 09123456789).';
                },
            },
            { id: 'licenseExpiry', check: licenseExpiryError },
            requireChoice('specialization', 'Please select your specialization.'),
            {
                id: 'customSpecialization',
                check: () => (valueOf('specialization') === 'Other' && !valueOf('customSpecialization') ? 'Please specify your specialization.' : ''),
            },
        ],
    },
};

// null when every rule on the step passes; otherwise the failing field ids (in
// on-screen order) and the message: the field's own one when a single field is
// wrong, the step's "complete all" message when several are.
function checkStep(stepId) {
    const step = STEP_RULES[stepId];
    if (!step) return null;
    const failed = step.rules
        .map((rule) => ({ id: rule.id, message: rule.check() }))
        .filter((result) => result.message);
    if (!failed.length) return null;
    return {
        ids: failed.map((result) => result.id),
        message: failed.length > 1 ? step.allMessage : failed[0].message,
    };
}

function markInvalidFields(stepId, invalidIds) {
    const step = STEP_RULES[stepId];
    if (!step) return;
    step.rules.forEach((rule) => {
        const el = byId(rule.id);
        if (el && typeof el.setAttribute === 'function') {
            el.setAttribute('aria-invalid', invalidIds.includes(rule.id) ? 'true' : 'false');
        }
    });
}

// Shows a problem in the step's own error line, marks the fields it names and
// (with focus) moves the cursor to the first of them. Nothing typed is cleared.
function reportStepProblem(stepId, problem, { focus = true } = {}) {
    const step = STEP_RULES[stepId];
    markInvalidFields(stepId, problem ? problem.ids : []);
    setMessage(step.error, problem ? problem.message : '');
    if (!problem || !focus) return;
    const errorEl = byId(step.error);
    if (errorEl && typeof errorEl.scrollIntoView === 'function') {
        errorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const first = problem.ids.length ? byId(problem.ids[0]) : null;
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
}

// True when every required field on the step is acceptable.
function validateStep(stepId, options) {
    const problem = checkStep(stepId);
    reportStepProblem(stepId, problem, options);
    return !problem;
}

// Whether go() may move past this step. A failing step is put on screen first, so
// its message is never shown on a step the user cannot see.
function canLeaveStep(stepId) {
    if (!STEP_RULES[stepId]) return true;
    const ageOk = stepId !== 'sp2' || !window.KCChildAge || window.KCChildAge.checkChildAge(valueOf('dob')).ok;
    if (!checkStep(stepId) && ageOk) {
        reportStepProblem(stepId, null);
        return true;
    }
    if (!isStepActive(stepId)) show(stepId);
    if (!validateStep(stepId)) return false;
    // Child Information: every field is filled in, so now the 3 to 8 year rule.
    return stepId !== 'sp2' || validateChildAge();
}

// Once a step has told the user what is missing, keep that message in step with
// what they correct (the same way the consent message behaves).
function refreshStepMessage(stepId) {
    const errorEl = byId(STEP_RULES[stepId].error);
    if (errorEl && errorEl.textContent) validateStep(stepId, { focus: false });
}

// Child age requirement (js/shared/child-age.js; routes/auth.js enforces the same
// rule). Under 3 or over 8 opens the age notice; a missing, malformed or future
// date uses the step's own error line. Either way nothing entered is cleared and
// the user stays on Child Information.
function validateChildAge() {
    const ageRule = window.KCChildAge;
    // The server still rejects an ineligible child if the rule failed to load.
    if (!ageRule) return true;

    const check = ageRule.checkChildAge(valueOf('dob'));
    if (check.ok) {
        setMessage('ep2', '');
        return true;
    }

    if (check.reason === 'too_young' || check.reason === 'too_old') {
        setMessage('ep2', '');
        showAgeDialog(check.title, check.message);
        return false;
    }

    setMessage('ep2', check.message);
    const errorEl = byId('ep2');
    if (errorEl && typeof errorEl.scrollIntoView === 'function') {
        errorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const dob = byId('dob');
    if (dob && typeof dob.focus === 'function') dob.focus({ preventScroll: true });
    return false;
}

function showAgeDialog(title, message) {
    const dialog = byId('ageDialog');
    if (!dialog || typeof dialog.showModal !== 'function') {
        // No <dialog> support: the step's error line carries the same message.
        setMessage('ep2', message);
        return;
    }
    const titleEl = byId('ageDialogTitle');
    if (titleEl) titleEl.textContent = title;
    setMessage('ageDialogMessage', message);
    if (!dialog.open) dialog.showModal();
    const okBtn = byId('ageDialogOkBtn');
    if (okBtn) okBtn.focus();
}

// The picker only offers eligible dates; typed dates still go through validateChildAge.
function limitDobPicker() {
    const dob = byId('dob');
    if (!dob || !window.KCChildAge) return;
    const range = window.KCChildAge.eligibleBirthDateRange(window.KCChildAge.localToday());
    dob.min = range.min;
    dob.max = range.max;
}

function previewPhoto(inputId, previewId, placeholderId) {
    const input = byId(inputId);
    const preview = byId(previewId);
    const placeholder = byId(placeholderId);

    if (input?.files?.[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            if (preview) {
                preview.src = e.target.result;
                preview.style.display = 'block';
            }
            if (placeholder) placeholder.style.display = 'none';
        };
        reader.readAsDataURL(input.files[0]);
    }
}

// POSTs a multipart registration so the photos the user picked are actually sent.
//
// The form has always had parentPhotoInput and childPhotoInput, and
// previewPhoto() rendered a local FileReader data-URL so the user saw their
// picture on screen — but verifyAndRegister() then sent a JSON body with no
// image fields, so both files were silently discarded and every account was
// created with the default avatar.
//
// routes/auth.js already accepts `parentProfilePhoto` and `childProfilePhoto`
// on /api/auth/register (see handleProfileUpload) and writes them to
// user.profileIcon / child.profileIcon. This just supplies what that code was
// always waiting for — no new endpoint and no change to the saved fields.
async function postRegistrationWithPhotos(payload) {
    const body = new FormData();

    // Empty optional values are omitted rather than appended: FormData
    // stringifies null to the literal text "null".
    Object.entries(payload).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') return;
        body.append(key, String(value));
    });

    const parentPhoto = byId('parentPhotoInput')?.files?.[0];
    const childPhoto = byId('childPhotoInput')?.files?.[0];
    if (parentPhoto) body.append('parentProfilePhoto', parentPhoto);
    if (childPhoto) body.append('childProfilePhoto', childPhoto);

    const response = await fetch('/api/auth/register', { method: 'POST', body });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || result.message || `Request failed with status ${response.status}`);
    }
    return result;
}

function toggleCustomSpecialization() {
    const spec = byId('specialization');
    const customGroup = byId('customSpecializationGroup');

    if (spec && customGroup) {
        customGroup.style.display = spec.value === 'Other' ? 'block' : 'none';
    }
}

function otpNext(input, nextId) {
    input.value = input.value.replace(/\D/g, '').slice(0, 1);
    if (input.value && nextId) {
        const next = byId(nextId);
        if (next) next.focus();
    }
}

function otpBack(event, previousId, input) {
    if (event.key === 'Backspace' && !input.value && previousId) {
        const previous = byId(previousId);
        if (previous) previous.focus();
    }
}

function collectOtp(prefix) {
    return [1, 2, 3, 4].map((n) => valueOf(`${prefix}${n}`)).join('');
}

function validateEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function postJson(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(result.error || result.message || `Request failed with status ${response.status}`);
    }
    return result;
}

// Puts a button into its "working" state and returns the restore function.
//
// The original label is remembered ON the button the first time it is put into
// a loading state, not in a local variable. Two overlapping calls on the same
// button used to capture "Sending..." as the second call's "original" text, so
// the restore left the button reading "Sending..." for good. Restoring from the
// remembered label makes that impossible, so a button never sticks.
function setButtonLoading(buttonId, loadingText) {
    const button = byId(buttonId);
    if (!button) return () => {};

    if (button.kcOriginalText === undefined) button.kcOriginalText = button.textContent;
    button.disabled = true;
    button.textContent = loadingText;

    return () => {
        button.disabled = false;
        if (button.kcOriginalText !== undefined) {
            button.textContent = button.kcOriginalText;
            button.kcOriginalText = undefined;
        }
    };
}

// One OTP request in flight per role. A second click while a request is running
// is dropped instead of queued: every /api/auth/send-otp call replaces the
// previous unused code, so two overlapping sends would invalidate the code in
// the email the user is about to read.
const otpSendInFlight = { parent: false, pediatrician: false };

// The Login Credentials checks: the step's own fields (STEP_RULES.sp4 / sd3) plus
// the name from the earlier step. Returns null or { ids, message } like checkStep().
function credentialProblem(kind) {
    if (kind === 'parent') {
        // Still checked here, the single gate before the OTP is sent: a blank name
        // would otherwise only fail at /register, after the code had been spent.
        return checkStep('sp4') || (!valueOf('pFirst') || !valueOf('pLast')
            ? { ids: [], message: 'Please go back and enter your first and last name.' }
            : null);
    }
    return (!valueOf('dFirst') || !valueOf('dLast')
        ? { ids: [], message: 'Please enter your first and last name.' }
        : null) || checkStep('sd3');
}

function validateParentCredentials() {
    const problem = credentialProblem('parent');
    return problem ? problem.message : '';
}

function validateDoctorCredentials() {
    const problem = credentialProblem('pediatrician');
    return problem ? problem.message : '';
}

// ── Terms of Service & consent (sign-up only) ────────────────────────────────
// The wording of the three selections is in the markup, copied verbatim from
// legal/KINDERCURA-TERMS-OF-SERVICE.txt (section 17). This code only checks that
// the two REQUIRED boxes are ticked before an account can be created; the
// optional machine-learning box never blocks anything. Login is not affected.
const TERMS_TEXT_URL = '/legal/KINDERCURA-TERMS-OF-SERVICE.txt';

const CONSENT_IDS = {
    parent:       { terms: 'pAcceptTerms', privacy: 'pAckPrivacy', ml: 'pMlConsent', error: 'pConsentError' },
    pediatrician: { terms: 'dAcceptTerms', privacy: 'dAckPrivacy', ml: 'dMlConsent', error: 'dConsentError' },
};

function readConsent(kind) {
    const ids = CONSENT_IDS[kind];
    return {
        acceptTerms: Boolean(byId(ids.terms)?.checked),
        acknowledgePrivacy: Boolean(byId(ids.privacy)?.checked),
        mlConsent: Boolean(byId(ids.ml)?.checked),
    };
}

function consentErrorMessage(consent) {
    if (!consent.acceptTerms && !consent.acknowledgePrivacy) {
        return 'Please accept the Terms of Service and acknowledge the Privacy Notice to continue.';
    }
    if (!consent.acceptTerms) return 'Please accept the Terms of Service to continue.';
    if (!consent.acknowledgePrivacy) return 'Please acknowledge the Privacy Notice to continue.';
    return '';
}

// True when both REQUIRED selections are made. Otherwise it shows a message inside
// the consent block, marks the missing checkboxes aria-invalid and (when they are on
// screen) moves focus to the first one. It reads and writes ONLY the consent
// controls, so nothing the user has typed elsewhere is ever cleared.
function validateConsent(kind, { focus = true } = {}) {
    const ids = CONSENT_IDS[kind];
    const consent = readConsent(kind);
    const message = consentErrorMessage(consent);
    const termsEl = byId(ids.terms);
    const privacyEl = byId(ids.privacy);

    if (termsEl) termsEl.setAttribute('aria-invalid', consent.acceptTerms ? 'false' : 'true');
    if (privacyEl) privacyEl.setAttribute('aria-invalid', consent.acknowledgePrivacy ? 'false' : 'true');

    setMessage(ids.error, message);
    if (message && focus) {
        const first = !consent.acceptTerms ? termsEl : privacyEl;
        if (first && typeof first.focus === 'function') first.focus();
    }
    return !message;
}

// For the later steps (resend / final submit), where the checkboxes are not on screen:
// if a required box is not ticked, reopen the consent modal that holds them and show
// the message there, instead of failing somewhere the user cannot act.
function requireConsent(kind) {
    if (validateConsent(kind, { focus: false })) return true;
    openConsentDialog(kind);
    validateConsent(kind);
    return false;
}

// Sign-up is Login Credentials -> Terms of Service & Consent modal -> email verification,
// all on signup.html. The consent selections live in a modal <dialog> opened over the
// Login Credentials step by continueToConsent(); its "I Agree & Continue" button is the
// existing send-code action (sendOTP / sendDoctorOTP).
const SIGNUP_STEPS = {
    parent: {
        credentials: 'sp4', credentialsError: 'ep4', continueBtn: 'pCredentialsNextBtn', email: 'pEmail',
        dialog: 'pConsentDialog', dialogTitle: 'pConsentDialogTitle', consentError: 'ep4c',
    },
    pediatrician: {
        credentials: 'sd3', credentialsError: 'ed3', continueBtn: 'dCredentialsNextBtn', email: 'dEmail',
        dialog: 'dConsentDialog', dialogTitle: 'dConsentDialogTitle', consentError: 'ed3c',
    },
};

function isStepActive(stepId) {
    const step = byId(stepId);
    return Boolean(step && step.classList && typeof step.classList.contains === 'function' && step.classList.contains('active'));
}

// Opens the consent modal over the Login Credentials step. showModal() gives the dimmed
// backdrop, makes the page behind it inert, keeps Tab inside the modal and closes on
// Escape; browsers without <dialog> show it in place instead.
function openConsentDialog(kind) {
    const steps = SIGNUP_STEPS[kind];
    const dialog = byId(steps.dialog);
    if (!dialog) return false;
    // Coming Back from the verification step: the modal belongs over the credentials.
    if (!isStepActive(steps.credentials)) show(steps.credentials);
    if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
    } else {
        dialog.setAttribute('open', '');
    }
    const body = typeof dialog.querySelector === 'function' ? dialog.querySelector('.consent-dialog-body') : null;
    if (body) body.scrollTop = 0;
    // Focus the title so screen readers announce the modal and Tab starts at its top.
    const heading = byId(steps.dialogTitle);
    if (heading && typeof heading.focus === 'function') heading.focus({ preventScroll: true });
    return true;
}

// Closes the modal without any other effect: nothing is sent, nothing is cleared.
function hideConsentDialog(kind) {
    const dialog = byId(SIGNUP_STEPS[kind].dialog);
    if (!dialog) return;
    if (typeof dialog.close === 'function') {
        if (dialog.open) dialog.close();
    } else if (typeof dialog.removeAttribute === 'function') {
        dialog.removeAttribute('open');
    }
}

// "Back to Registration" (and Escape): close the modal and put the user back on the
// Login Credentials form with everything they typed still in place. While a code is
// being sent the modal stays open, so the request finishes where it started.
function closeConsentDialog(kind) {
    if (otpSendInFlight[kind]) return false;
    hideConsentDialog(kind);
    const continueBtn = byId(SIGNUP_STEPS[kind].continueBtn);
    if (continueBtn && typeof continueBtn.focus === 'function') continueBtn.focus();
    return true;
}

// "Continue" on the Login Credentials step. Runs the same credential checks the
// send step has always run and only then opens the consent modal. Nothing is sent
// to the server here: no code, no account. Typed values stay in their inputs, so
// Back to Registration finds them as they were.
function continueToConsent(kind) {
    const steps = SIGNUP_STEPS[kind];
    const problem = credentialProblem(kind);
    reportStepProblem(steps.credentials, problem);
    if (problem) return false;
    // A failure message from an earlier send attempt no longer applies.
    setMessage(steps.consentError, '');
    return openConsentDialog(kind);
}

// Back to the Login Credentials form, with the modal closed.
function backToCredentials(kind) {
    const steps = SIGNUP_STEPS[kind];
    hideConsentDialog(kind);
    if (!isStepActive(steps.credentials)) show(steps.credentials);
}

// The address is already registered: only the credentials form can fix that,
// so close the modal, take the user there and say why.
function showEmailExists(kind) {
    const steps = SIGNUP_STEPS[kind];
    setMessage(steps.consentError, '');
    backToCredentials(kind);
    setMessage(steps.credentialsError, 'An account with this email already exists. Please sign in.');
    const email = byId(steps.email);
    if (email && typeof email.focus === 'function') email.focus();
}

// Leaving the modal for the verification step: close it and put the cursor in the
// first code box.
function moveToCodeEntry(kind, stepId, firstBoxId) {
    hideConsentDialog(kind);
    show(stepId);
    const first = byId(firstBoxId);
    if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
}

let termsLoaded = false;
let termsTrigger = null;

// Renders the Terms one line at a time with textContent, so the wording is exactly
// the file's. Only the block type (heading / paragraph / divider) is chosen; no
// text is added, removed, reordered or rewritten.
function renderTermsDocument(text, container) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    container.textContent = '';
    lines.forEach((line, i) => {
        let el;
        let sectionNo = null;
        if (/^_{5,}$/.test(line)) {
            el = document.createElement('hr');
        } else {
            let tag = 'p';
            let cls = '';
            if (i === 0) cls = 'terms-brand';
            else if (i === 1) { tag = 'h3'; cls = 'terms-doc-title'; }
            else if (/^(Effective Date|Last Updated|Version):/.test(line)) cls = 'terms-meta';
            else if (/^\d+\.\s/.test(line) && line === line.toUpperCase()) { tag = 'h4'; cls = 'terms-section-heading'; sectionNo = /^(\d+)\./.exec(line)[1]; }
            else if ((lines[i + 1] || '').startsWith('☐')) { tag = 'h5'; cls = 'terms-subheading'; }
            el = document.createElement(tag);
            if (cls) el.className = cls;
            el.textContent = line;
            // Numbered headings get the source's own section number as an anchor, so a link can
            // open the Terms at a given section (for example section 7, PRIVACY AND COOKIES).
            if (sectionNo) {
                el.id = `terms-section-${sectionNo}`;
                el.setAttribute('tabindex', '-1');
            }
        }
        container.appendChild(el);
    });
}

async function loadTermsDocument() {
    const body = byId('termsDialogBody');
    if (!body || termsLoaded) return;
    try {
        const response = await fetch(TERMS_TEXT_URL, { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        renderTermsDocument(await response.text(), body);
        termsLoaded = true;
    } catch (err) {
        body.textContent = '';
        const p = document.createElement('p');
        p.className = 'terms-status';
        p.appendChild(document.createTextNode('The Terms of Service could not be loaded here. '));
        const link = document.createElement('a');
        link.href = TERMS_TEXT_URL;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Open the Terms of Service as a plain text file.';
        p.appendChild(link);
        body.appendChild(p);
    }
}

// Scrolls the open Terms to a numbered section and moves focus to its heading, so
// keyboard and screen-reader users land there too. No-op if the section is not rendered.
function jumpToTermsSection(section) {
    const heading = byId(`terms-section-${section}`);
    if (!heading) return false;
    heading.scrollIntoView({ block: 'start' });
    if (typeof heading.focus === 'function') heading.focus({ preventScroll: true });
    return true;
}

// Returns true when the dialog was opened. False (no <dialog> support) lets the
// link's normal behaviour run, which opens the plain-text file in a new tab.
// With a `section` number the Terms open at that section; otherwise at the top.
function openTermsDialog(trigger, section) {
    const dialog = byId('termsDialog');
    if (!dialog || typeof dialog.showModal !== 'function') return false;
    termsTrigger = trigger || null;
    if (!dialog.open) dialog.showModal();
    const body = byId('termsDialogBody');
    if (body) body.scrollTop = 0;
    const loading = loadTermsDocument();
    if (section) loading.then(() => jumpToTermsSection(section));
    return true;
}

async function sendOTP(isResend = false) {
    const error = validateParentCredentials();
    if (error) {
        // Normally caught by continueToConsent(); kept as the final gate before a send.
        backToCredentials('parent');
        setMessage('ep4', error);
        return;
    }
    if (!(isResend ? requireConsent('parent') : validateConsent('parent'))) return;
    // Send failures are shown on the step the user is looking at.
    const sendErrorId = isResend ? 'ep5e' : 'ep4c';

    if (otpSendInFlight.parent) return;
    otpSendInFlight.parent = true;

    // The button being clicked is the one that shows the progress. This used to
    // load 'verifyBtn' — the Verify & Continue button on the NEXT step — so the
    // Send Verification Code button never disabled and never changed label.
    const restore = setButtonLoading(isResend ? 'resendOtpBtn' : 'sendOtpBtn', isResend ? 'Resending...' : 'Sending...');
    try {
        const email = valueOf('pEmail').toLowerCase();
        parentVerifiedEmail = null;
        console.log('[SIGNUP] Send OTP clicked');
        console.log('[SIGNUP] Request payload:', { email });

        const response = await fetch('/api/auth/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });

        const result = await response.json().catch(() => ({}));
        console.log('[SIGNUP] API response:', { status: response.status, body: result });

        if (!response.ok) {
            if (response.status === 409 && result.code === 'EMAIL_EXISTS') {
                console.log('[SIGNUP] Existing user found:', email);
                showEmailExists('parent');
                return;
            }
            console.log('[SIGNUP] Frontend blocked:', result.error);
            setMessage(sendErrorId, result.error || result.message || 'Request failed.');
            return;
        }

        setMessage('ep4', '');
        setMessage('ep4c', '');
        setMessage('ep5e', '');
        setMessage('ep5s', isResend ? 'A new verification code was sent.' : 'Verification code sent.');
        const otpEmail = byId('otpEmail');
        if (otpEmail) otpEmail.textContent = email;
        console.log('[SIGNUP] Verification UI opened');
        moveToCodeEntry('parent', 'sp5', 'o1');
    } catch (err) {
        console.log('[SIGNUP] Frontend blocked:', err.message);
        setMessage(sendErrorId, err.message);
    } finally {
        otpSendInFlight.parent = false;
        restore();
    }
}

// The e-mail whose code has already been accepted in this session. /verify-otp
// marks a code used, so re-sending the same one after a failed /register got
// back 'Invalid OTP.' and hid the real error. Cleared whenever a new code is
// sent, so a resend still has to be verified.
let parentVerifiedEmail = null;

async function verifyAndRegister() {
    const otp = collectOtp('o');
    const email = valueOf('pEmail').toLowerCase();

    if (otp.length !== 4) {
        setMessage('ep5e', 'Please enter the 4-digit verification code.');
        return;
    }
    // Final guard, before the code is consumed or an account is created.
    if (!requireConsent('parent')) return;

    const restore = setButtonLoading('verifyBtn', 'Verifying...');
    try {
        if (parentVerifiedEmail !== email) {
            await postJson('/api/auth/verify-otp', { email, code: otp });
            parentVerifiedEmail = email;
        }

        const consent = readConsent('parent');
        const payload = {
            role: 'parent',
            firstName: valueOf('pFirst'),
            middleName: valueOf('pMiddle') || null,
            lastName: valueOf('pLast'),
            username: valueOf('pUsername'),
            email,
            password: rawValueOf('pPassword'),
            childFirstName: valueOf('childFirst'),
            childMiddleName: valueOf('childMiddle') || null,
            childLastName: valueOf('childLast'),
            dateOfBirth: valueOf('dob'),
            gender: valueOf('childGender') || null,
            relationship: valueOf('relationship') || null,
            acceptTerms: consent.acceptTerms,
            acknowledgePrivacy: consent.acknowledgePrivacy,
            mlConsent: consent.mlConsent,
        };

        // Multipart, so the selected parent/child photos travel with the
        // registration instead of being dropped on navigation.
        const result = await postRegistrationWithPhotos(payload);
        if (result.token) {
            localStorage.setItem('kc_token', result.token);
            localStorage.setItem('kc_user', JSON.stringify(result.user));
            if (result.childId) localStorage.setItem('kc_childId', result.childId);
        }

        window.location.href = result.needsPreAssessment ? '/parent/screening.html' : '/parent/dashboard.html';
    } catch (err) {
        // A code the server will not accept is only recoverable by asking for
        // a new one, so say so rather than leaving the user to guess. Resending
        // deletes the unused row, which is why an older code stops working.
        // Drop the stale “code sent” line: now that these boxes are visible,
        // leaving it would show a success and a failure side by side.
        setMessage('ep5s', '');
        const rejectedCode = /invalid otp|otp expired/i.test(err.message || '');
        setMessage('ep5e', rejectedCode
            ? `${err.message} Tap “Resend Code” above and enter the newest code from your e-mail.`
            : err.message);
        if (rejectedCode) {
            ['1', '2', '3', '4'].forEach((n) => { const box = byId(`o${n}`); if (box) box.value = ''; });
            const first = byId('o1');
            if (first) first.focus();
        }
    } finally {
        restore();
    }
}

async function sendDoctorOTP(isResend = false) {
    const error = validateDoctorCredentials();
    if (error) {
        // Normally caught by continueToConsent(); kept as the final gate before a send.
        backToCredentials('pediatrician');
        setMessage('ed3', error);
        return;
    }
    if (!(isResend ? requireConsent('pediatrician') : validateConsent('pediatrician'))) return;
    // Send failures are shown on the step the user is looking at.
    const sendErrorId = isResend ? 'ed4e' : 'ed3c';

    if (otpSendInFlight.pediatrician) return;
    otpSendInFlight.pediatrician = true;

    // Same fix as the parent flow: load the button that was actually clicked,
    // not 'dVerifyBtn' on the step that has not been shown yet.
    const restore = setButtonLoading(isResend ? 'dResendOtpBtn' : 'dSendOtpBtn', isResend ? 'Resending...' : 'Sending...');
    try {
        const email = valueOf('dEmail').toLowerCase();
        console.log('[SIGNUP] Send OTP clicked');
        console.log('[SIGNUP] Request payload:', { email });

        const response = await fetch('/api/auth/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
        });

        const result = await response.json().catch(() => ({}));
        console.log('[SIGNUP] API response:', { status: response.status, body: result });

        if (!response.ok) {
            if (response.status === 409 && result.code === 'EMAIL_EXISTS') {
                console.log('[SIGNUP] Existing user found:', email);
                showEmailExists('pediatrician');
                return;
            }
            console.log('[SIGNUP] Frontend blocked:', result.error);
            setMessage(sendErrorId, result.error || result.message || 'Request failed.');
            return;
        }

        setMessage('ed3', '');
        setMessage('ed3c', '');
        setMessage('ed4e', '');
        setMessage('ed4s', isResend ? 'A new verification code was sent.' : 'Verification code sent.');
        const otpEmail = byId('dOtpEmail');
        if (otpEmail) otpEmail.textContent = email;
        console.log('[SIGNUP] Verification UI opened');
        moveToCodeEntry('pediatrician', 'sd4', 'd1');
    } catch (err) {
        console.log('[SIGNUP] Frontend blocked:', err.message);
        setMessage(sendErrorId, err.message);
    } finally {
        otpSendInFlight.pediatrician = false;
        restore();
    }
}

async function verifyDoctorOTP() {
    const otp = collectOtp('d');
    const email = valueOf('dEmail').toLowerCase();

    if (otp.length !== 4) {
        setMessage('ed4e', 'Please enter the 4-digit verification code.');
        return;
    }

    const restore = setButtonLoading('dVerifyBtn', 'Verifying...');
    try {
        await postJson('/api/auth/verify-otp', { email, code: otp });
        setMessage('ed4e', '');
        setMessage('ed4s', 'Email verified.');
        show('sd5');
    } catch (err) {
        setMessage('ed4e', err.message);
    } finally {
        restore();
    }
}

async function registerPedia() {
    const submitBtn = byId('dSubmitBtn');
    const originalText = submitBtn?.textContent || 'Submit for Verification';

    try {
        const credentialError = validateDoctorCredentials();
        if (credentialError) {
            setMessage('ed5', credentialError);
            return;
        }
        // Professional Information & PRC Verification (STEP_RULES.sd5).
        if (!validateStep('sd5')) {
            return;
        }
        // Final guard: nothing is sent to the server unless both REQUIRED boxes are ticked.
        if (!requireConsent('pediatrician')) {
            return;
        }
        const consent = readConsent('pediatrician');

        const docIdFile = byId('docIdInput').files[0];
        const licenseNumber = valueOf('license');
        let specialization = valueOf('specialization');
        if (specialization === 'Other') {
            specialization = valueOf('customSpecialization');
        }

        const formData = new FormData();
        formData.append('role', 'pediatrician');
        formData.append('firstName', valueOf('dFirst'));
        formData.append('middleName', valueOf('dMiddle'));
        formData.append('lastName', valueOf('dLast'));
        formData.append('username', valueOf('dUsername'));
        formData.append('email', valueOf('dEmail').toLowerCase());
        formData.append('password', rawValueOf('dPassword'));
        formData.append('confirmPassword', rawValueOf('dConfirm'));
        formData.append('prcLicenseNumber', licenseNumber);
        formData.append('licenseNumber', licenseNumber);
        formData.append('institution', valueOf('institution'));
        formData.append('clinicName', valueOf('clinicName'));
        formData.append('clinicAddress', valueOf('clinicAddress'));
        formData.append('phoneNumber', valueOf('pediaPhone'));
        formData.append('licenseExpiry', valueOf('licenseExpiry'));
        formData.append('specialization', specialization);
        formData.append('acceptTerms', String(consent.acceptTerms));
        formData.append('acknowledgePrivacy', String(consent.acknowledgePrivacy));
        formData.append('mlConsent', String(consent.mlConsent));
        formData.append('prcIdCard', docIdFile);

        console.log([...formData.keys()]);
        console.log("License Number:", licenseNumber);
        console.log("Expiry:", valueOf('licenseExpiry'));
        console.log("Selected PRC File:", docIdFile);

        console.log('[PRC Upload][signup] PRC ID Card attached:', {
            name: docIdFile.name,
            size: docIdFile.size,
            type: docIdFile.type,
            licenseNumber,
            hasLicenseExpiry: Boolean(valueOf('licenseExpiry')),
            formKeys: Array.from(formData.keys()).filter((key) => !/password/i.test(key)),
        });

        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting...';
        }

        const response = await fetch('/api/auth/register', {
            method: 'POST',
            body: formData,
        });

        const result = await response.json().catch(() => ({}));
        console.log('[PRC Upload][signup] Registration API response:', {
            ok: response.ok,
            status: response.status,
            success: result.success,
            userId: result.userId,
            role: result.role,
            accountStatus: result.status,
            message: result.message || result.error,
        });

        if (response.ok && result.success) {
            setMessage('ed5', '');
            const modal = byId('regSuccessModal');
            if (modal) modal.style.display = 'flex';
            setTimeout(() => {
                window.location.href = '/login.html';
            }, 3000);
            return;
        }

        setMessage('ed5', result.error || result.message || 'Registration failed. Please try again.');
    } catch (error) {
        console.error('Registration error:', error);
        setMessage('ed5', 'An error occurred during registration. Please try again.');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
}

document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('input[name="role"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            selectedRole = radio.value;
            setMessage('e1', '');
        });
    });

    // Escape on a consent modal behaves exactly like "Back to Registration".
    Object.keys(SIGNUP_STEPS).forEach((kind) => {
        const dialog = byId(SIGNUP_STEPS[kind].dialog);
        if (!dialog) return;
        dialog.addEventListener('cancel', (event) => {
            event.preventDefault();
            closeConsentDialog(kind);
        });
    });

    // Keep the consent message in step with what the user ticks once they have been told
    // what is missing.
    Object.keys(CONSENT_IDS).forEach((kind) => {
        const ids = CONSENT_IDS[kind];
        [ids.terms, ids.privacy].forEach((id) => {
            const box = byId(id);
            if (!box) return;
            box.addEventListener('change', () => {
                const errorEl = byId(ids.error);
                if (errorEl && errorEl.textContent) validateConsent(kind, { focus: false });
            });
        });
    });

    // Required fields: once a step has said what is missing, correcting a field
    // updates (or clears) that message. 'input' fires for text, date, select and
    // file inputs alike.
    Object.keys(STEP_RULES).forEach((stepId) => {
        STEP_RULES[stepId].rules.forEach((rule) => {
            const field = byId(rule.id);
            if (field) field.addEventListener('input', () => refreshStepMessage(stepId));
        });
    });

    // Terms reader: the link still opens the plain-text file if the dialog is unavailable.
    const termsDialog = byId('termsDialog');
    document.querySelectorAll('.terms-open-link').forEach((link) => {
        link.addEventListener('click', (event) => {
            if (openTermsDialog(link, link.getAttribute('data-terms-section'))) event.preventDefault();
        });
    });
    if (termsDialog) {
        const closeBtn = byId('termsDialogClose');
        if (closeBtn) closeBtn.addEventListener('click', () => termsDialog.close());
        termsDialog.addEventListener('click', (event) => {
            if (event.target === termsDialog) termsDialog.close();
        });
        termsDialog.addEventListener('close', () => {
            if (termsTrigger && typeof termsTrigger.focus === 'function') termsTrigger.focus();
        });
    }

    limitDobPicker();
    const dobInput = byId('dob');
    if (dobInput) dobInput.addEventListener('change', () => setMessage('ep2', ''));

    // Closing the age notice (OK or Escape) returns to the date of birth field.
    const ageDialog = byId('ageDialog');
    if (ageDialog) {
        const ageOkBtn = byId('ageDialogOkBtn');
        if (ageOkBtn) ageOkBtn.addEventListener('click', () => ageDialog.close());
        ageDialog.addEventListener('close', () => {
            if (dobInput && typeof dobInput.focus === 'function') dobInput.focus();
        });
    }

    const okBtn = byId('regSuccessOkBtn');
    if (okBtn) {
        okBtn.addEventListener('click', function() {
            window.location.href = '/login.html';
        });
    }
});
