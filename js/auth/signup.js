// Signup page helpers for parent and pediatrician onboarding.

let selectedRole = '';

function byId(id) {
    return document.getElementById(id);
}

function valueOf(id) {
    const el = byId(id);
    return el ? String(el.value || '').trim() : '';
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

    if (role === 'parent') {
        const parentSteps = {
            1: 's1',
            2: 'sp2',
            3: 'sp3',
            4: 'sp4',
            5: 'sp5',
        };
        show(parentSteps[step] || 's1');
        return;
    }

    const doctorSteps = {
        1: 's1',
        2: 'sd2',
        3: 'sd3',
        4: 'sd4',
        5: 'sd5',
    };
    show(doctorSteps[step] || 's1');
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

function setButtonLoading(buttonId, loadingText) {
    const button = byId(buttonId);
    if (!button) return () => {};

    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = loadingText;

    return () => {
        button.disabled = false;
        button.textContent = originalText;
    };
}

function validateParentCredentials() {
    const email = valueOf('pEmail').toLowerCase();
    const password = valueOf('pPassword');
    const confirm = valueOf('pConfirm');

    if (!valueOf('pUsername') || !email || !password || !confirm) {
        return 'Please complete all parent login credentials.';
    }
    if (!validateEmail(email)) {
        return 'Please enter a valid email address.';
    }
    if (password.length < 8) {
        return 'Password must be at least 8 characters long.';
    }
    if (password !== confirm) {
        return 'Passwords do not match.';
    }
    return '';
}

function validateDoctorCredentials() {
    const email = valueOf('dEmail').toLowerCase();
    const password = valueOf('dPassword');
    const confirm = valueOf('dConfirm');

    if (!valueOf('dFirst') || !valueOf('dLast')) {
        return 'Please enter your first and last name.';
    }
    if (!valueOf('dUsername') || !email || !password || !confirm) {
        return 'Please complete all pediatrician login credentials.';
    }
    if (!validateEmail(email)) {
        return 'Please enter a valid email address.';
    }
    if (password.length < 8) {
        return 'Password must be at least 8 characters long.';
    }
    if (password !== confirm) {
        return 'Passwords do not match.';
    }
    return '';
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
// if a required box is not ticked, take the user back to the credentials step that
// holds them and show the message there, instead of failing somewhere they cannot act.
function requireConsent(kind, credentialsStepId) {
    if (validateConsent(kind, { focus: false })) return true;
    show(credentialsStepId);
    validateConsent(kind);
    return false;
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
        setMessage('ep4', error);
        return;
    }
    if (!(isResend ? requireConsent('parent', 'sp4') : validateConsent('parent'))) return;

    const restore = setButtonLoading('verifyBtn', 'Sending...');
    try {
        const email = valueOf('pEmail').toLowerCase();
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
                setMessage('ep4', 'An account with this email already exists. Please sign in.');
                return;
            }
            console.log('[SIGNUP] Frontend blocked:', result.error);
            setMessage('ep4', result.error || result.message || 'Request failed.');
            return;
        }

        setMessage('ep4', '');
        setMessage('ep5e', '');
        setMessage('ep5s', isResend ? 'A new verification code was sent.' : 'Verification code sent.');
        const otpEmail = byId('otpEmail');
        if (otpEmail) otpEmail.textContent = email;
        console.log('[SIGNUP] Verification UI opened');
        show('sp5');
    } catch (err) {
        console.log('[SIGNUP] Frontend blocked:', err.message);
        setMessage('ep4', err.message);
        setMessage('ep5e', err.message);
    } finally {
        restore();
    }
}

async function verifyAndRegister() {
    const otp = collectOtp('o');
    const email = valueOf('pEmail').toLowerCase();

    if (otp.length !== 4) {
        setMessage('ep5e', 'Please enter the 4-digit verification code.');
        return;
    }
    // Final guard, before the code is consumed or an account is created.
    if (!requireConsent('parent', 'sp4')) return;

    const restore = setButtonLoading('verifyBtn', 'Verifying...');
    try {
        await postJson('/api/auth/verify-otp', { email, code: otp });

        const consent = readConsent('parent');
        const payload = {
            role: 'parent',
            firstName: valueOf('pFirst'),
            middleName: valueOf('pMiddle') || null,
            lastName: valueOf('pLast'),
            username: valueOf('pUsername'),
            email,
            password: valueOf('pPassword'),
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
        setMessage('ep5e', err.message);
    } finally {
        restore();
    }
}

async function sendDoctorOTP(isResend = false) {
    const error = validateDoctorCredentials();
    if (error) {
        setMessage('ed3', error);
        return;
    }
    if (!(isResend ? requireConsent('pediatrician', 'sd3') : validateConsent('pediatrician'))) return;

    const restore = setButtonLoading('dVerifyBtn', 'Sending...');
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
                setMessage('ed3', 'An account with this email already exists. Please sign in.');
                return;
            }
            console.log('[SIGNUP] Frontend blocked:', result.error);
            setMessage('ed3', result.error || result.message || 'Request failed.');
            return;
        }

        setMessage('ed3', '');
        setMessage('ed4e', '');
        setMessage('ed4s', isResend ? 'A new verification code was sent.' : 'Verification code sent.');
        const otpEmail = byId('dOtpEmail');
        if (otpEmail) otpEmail.textContent = email;
        console.log('[SIGNUP] Verification UI opened');
        show('sd4');
    } catch (err) {
        console.log('[SIGNUP] Frontend blocked:', err.message);
        setMessage('ed3', err.message);
        setMessage('ed4e', err.message);
    } finally {
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

function validatePediatricianProfessionalInfo() {
    const docIdInput = byId('docIdInput');

    if (!docIdInput?.files?.[0]) {
        return 'Please upload your PRC ID Card for verification.';
    }
    if (!valueOf('license')) {
        return 'PRC License Number is required.';
    }
    if (!valueOf('pediaPhone')) {
        return 'Phone number is required.';
    }
    if (!valueOf('licenseExpiry')) {
        return 'PRC License Expiry Date is required.';
    }
    if (new Date(valueOf('licenseExpiry')) <= new Date()) {
        return 'License expiry must be a future date.';
    }
    if (valueOf('specialization') === 'Other' && !valueOf('customSpecialization')) {
        return 'Please specify your specialization.';
    }
    return '';
}

async function registerPedia() {
    const submitBtn = byId('dSubmitBtn');
    const originalText = submitBtn?.textContent || 'Submit for Verification';

    try {
        const credentialError = validateDoctorCredentials();
        const professionalError = validatePediatricianProfessionalInfo();

        if (credentialError || professionalError) {
            setMessage('ed5', credentialError || professionalError);
            return;
        }
        // Final guard: nothing is sent to the server unless both REQUIRED boxes are ticked.
        if (!requireConsent('pediatrician', 'sd3')) {
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
        formData.append('password', valueOf('dPassword'));
        formData.append('confirmPassword', valueOf('dConfirm'));
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

    const okBtn = byId('regSuccessOkBtn');
    if (okBtn) {
        okBtn.addEventListener('click', function() {
            window.location.href = '/login.html';
        });
    }
});
