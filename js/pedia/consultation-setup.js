// One-time consultation setup on the pediatrician dashboard.
//
// Shown while the saved profile has no available days: every new account starts
// that way and PUT /auth/pediatrician/settings refuses to save a schedule without
// days, so once completed it never returns. Saves through that same endpoint, so
// Settings and appointment booking read the values at once.
//
// Wrapped so it adds no globals; uses the page's apiFetch and doLogout.
(function () {
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

    function needsSetup(user) {
        return Boolean(user) && user.role === 'pediatrician'
            && Boolean(user.availability) && Array.isArray(user.availability.days) && user.availability.days.length === 0;
    }

    /** { field: message } for everything wrong; the server checks again. */
    function validate(v) {
        const errors = {};
        if (!v.phoneNumber) errors.phoneNumber = 'Enter your phone number.';
        // Same rule as sign-up.
        else if (!/^(09|\+639)\d{9}$/.test(v.phoneNumber.replace(/[\s-]/g, ''))) errors.phoneNumber = 'Enter a valid Philippine mobile number, like 09123456789.';
        if (!v.clinicName) errors.clinicName = 'Enter your clinic name.';
        if (!v.institution) errors.institution = 'Enter your hospital or institution.';
        const fee = Number(v.consultationFee);
        if (v.consultationFee === '' || !Number.isFinite(fee) || fee <= 0) errors.consultationFee = 'Enter a fee greater than zero.';
        const max = Number(v.maxPatientsPerDay);
        if (v.maxPatientsPerDay === '' || !Number.isInteger(max) || max < 1 || max > 50) errors.maxPatientsPerDay = 'Enter a whole number from 1 to 50.';
        if (!v.days.length) errors.days = 'Choose at least one day.';
        if (!TIME.test(v.startTime)) errors.startTime = 'Enter a start time.';
        if (!TIME.test(v.endTime)) errors.endTime = 'Enter an end time.';
        else if (!errors.startTime && v.endTime <= v.startTime) errors.endTime = 'End time must be later than start time.';
        return errors;
    }

    /** Only these fields, so no other setting is touched. */
    function buildPayload(v) {
        return {
            phoneNumber: v.phoneNumber,
            clinicName: v.clinicName,
            institution: v.institution,
            consultationFee: v.consultationFee,
            availability: { days: v.days, startTime: v.startTime, endTime: v.endTime, maxPatientsPerDay: v.maxPatientsPerDay },
        };
    }

    const field = (name, label, attrs) => `
        <div class="cs-field">
            <label for="cs-${name}">${label}</label>
            <input id="cs-${name}" aria-describedby="cs-${name}-err" required ${attrs}>
            <p class="cs-err" id="cs-${name}-err"></p>
        </div>`;

    const ILLUSTRATION = `
        <svg class="cs-art" viewBox="0 0 280 220" aria-hidden="true" focusable="false">
            <circle cx="140" cy="112" r="96" fill="#8BA98D"/>
            <ellipse cx="140" cy="196" rx="112" ry="12" fill="#5A7560"/>
            <path d="M74 196c0-40 18-62 44-62s44 22 44 62z" fill="#F4D89F"/>
            <circle cx="118" cy="96" r="36" fill="#F0DCD8"/>
            <path d="M82 94c0-26 16-40 36-40s36 14 36 40c-8-14-20-20-36-20s-28 6-36 20z" fill="#3D4738"/>
            <circle cx="106" cy="100" r="4" fill="#3D4738"/><circle cx="130" cy="100" r="4" fill="#3D4738"/>
            <circle cx="97" cy="110" r="5" fill="#E8A5A5"/><circle cx="139" cy="110" r="5" fill="#E8A5A5"/>
            <path d="M108 113q10 9 20 0" fill="none" stroke="#3D4738" stroke-width="3" stroke-linecap="round"/>
            <circle cx="184" cy="134" r="10" fill="#F8E5B5"/><circle cx="220" cy="134" r="10" fill="#F8E5B5"/>
            <ellipse cx="202" cy="180" rx="28" ry="20" fill="#F8E5B5"/>
            <circle cx="202" cy="148" r="24" fill="#F8E5B5"/>
            <ellipse cx="202" cy="156" rx="10" ry="8" fill="#FAFAF6"/>
            <circle cx="193" cy="145" r="3" fill="#3D4738"/><circle cx="211" cy="145" r="3" fill="#3D4738"/>
            <circle cx="202" cy="153" r="3" fill="#3D4738"/>
            <path d="M102 138v20a16 16 0 0 0 32 0v-20M118 174v6q0 10 22 10 24 0 30-14" fill="none" stroke="#3D4738" stroke-width="4" stroke-linecap="round"/>
            <circle cx="172" cy="172" r="8" fill="#FAFAF6" stroke="#3D4738" stroke-width="4"/>
            <path d="M62 60h10v-10h10v10h10v10h-10v10h-10v-10h-10z" fill="#FAFAF6"/>
            <path d="M214 92c-10-8-16-13-16-20a9 9 0 0 1 16-5 9 9 0 0 1 16 5c0 7-6 12-16 20z" fill="#E8A5A5"/>
        </svg>`;

    const TEMPLATE = `
        <div class="cs-brand">
            <p class="cs-logo"><img src="/icons/logo.png" alt=""> KinderCura</p>
            <h2 id="cs-title" tabindex="-1" autofocus></h2>
            <p class="cs-lead">Set up your consultation details so parents can find you and book their child's visit.</p>
            ${ILLUSTRATION}
        </div>
        <div class="cs-main">
            <form id="cs-form" novalidate>
                <h3 class="cs-heading">Consultation profile</h3>
                <p class="cs-note">All fields are required. This takes about a minute.</p>
                <fieldset><legend>Contact Information</legend>
                    <div class="cs-grid">
                        ${field('phoneNumber', 'Phone Number', 'type="tel" autocomplete="tel" maxlength="20" placeholder="09123456789"')}
                        ${field('clinicName', 'Clinic Name', 'type="text" maxlength="120"')}
                        ${field('institution', 'Hospital / Institution Name', 'type="text" maxlength="120"')}
                    </div>
                </fieldset>
                <fieldset><legend>Consultation Details</legend>
                    <div class="cs-grid">
                        ${field('consultationFee', 'Consultation Fee (PHP)', 'type="number" min="1" step="0.01" inputmode="decimal"')}
                        ${field('maxPatientsPerDay', 'Maximum Patients per Day', 'type="number" min="1" max="50" step="1" inputmode="numeric"')}
                    </div>
                </fieldset>
                <fieldset><legend>Availability Schedule</legend>
                    <div class="cs-field" role="group" aria-labelledby="cs-days-label" aria-describedby="cs-days-err">
                        <span class="cs-label" id="cs-days-label">Available Days</span>
                        <div class="cs-days">${DAYS.map((d) => `<label><input type="checkbox" name="csDay" value="${d}"><span>${d}</span></label>`).join('')}</div>
                        <p class="cs-err" id="cs-days-err"></p>
                    </div>
                    <div class="cs-grid">
                        ${field('startTime', 'Consultation Start Time', 'type="time"')}
                        ${field('endTime', 'Consultation End Time', 'type="time"')}
                    </div>
                </fieldset>
                <p class="cs-err cs-err--form" id="cs-form-err" role="alert"></p>
                <div class="cs-actions">
                    <button type="button" class="cs-link" id="cs-logout">Log Out</button>
                    <button type="submit" class="btn btn-primary" id="cs-save">Confirm</button>
                </div>
            </form>
            <div class="cs-done" id="cs-done" role="status" hidden>
                <img src="/icons/approve_completed_mark.png" alt="">
                <h3 class="cs-heading">You're all set!</h3>
                <p>Your consultation details are saved. You can update them anytime through <strong>Profile Icon &gt; Settings</strong>.</p>
                <button type="button" class="btn btn-primary" id="cs-close">Go to Dashboard</button>
            </div>
        </div>`;

    const TEXT_FIELDS = ['phoneNumber', 'clinicName', 'institution', 'consultationFee', 'maxPatientsPerDay', 'startTime', 'endTime'];

    function open(user) {
        const dialog = document.createElement('dialog');
        dialog.className = 'cs-dialog';
        dialog.setAttribute('aria-labelledby', 'cs-title');
        dialog.innerHTML = TEMPLATE;
        const $ = (id) => dialog.querySelector(`#cs-${id}`);

        $('title').textContent = `Welcome, Dr. ${user.firstName || ''}!`;
        const start = { ...user, ...user.availability };
        TEXT_FIELDS.forEach((name) => { $(name).value = start[name] ?? ''; });

        let saving = false;
        let finished = false;
        const read = () => {
            const v = { days: Array.from(dialog.querySelectorAll('[name="csDay"]:checked')).map((b) => b.value) };
            TEXT_FIELDS.forEach((name) => { v[name] = String($(name).value).trim(); });
            return v;
        };
        const showErrors = (errors) => {
            [...TEXT_FIELDS, 'days'].forEach((name) => {
                $(`${name}-err`).textContent = errors[name] || '';
                if (name !== 'days') $(name).setAttribute('aria-invalid', errors[name] ? 'true' : 'false');
            });
            const first = TEXT_FIELDS.slice(0, 5).concat('days', 'startTime', 'endTime').find((n) => errors[n]);
            if (first) (first === 'days' ? dialog.querySelector('[name="csDay"]') : $(first)).focus();
        };

        $('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (saving) return;
            const values = read();
            const errors = validate(values);
            showErrors(errors);
            $('form-err').textContent = '';
            if (Object.keys(errors).length) return;

            saving = true;
            $('save').disabled = true;
            $('save').textContent = 'Saving…';
            try {
                const data = await apiFetch('/auth/pediatrician/settings', { method: 'PUT', body: JSON.stringify(buildPayload(values)) });
                try { localStorage.setItem('kc_user', JSON.stringify(data.user)); } catch {}
                finished = true;
                $('form').hidden = true;
                $('done').hidden = false;
                $('close').focus();
            } catch (err) {
                $('form-err').textContent = err.message || 'Could not save your details. Please try again.';
            } finally {
                saving = false;
                $('save').disabled = false;
                $('save').textContent = 'Confirm';
            }
        });
        $('logout').addEventListener('click', () => doLogout());
        $('close').addEventListener('click', () => {
            dialog.close();
            document.body.classList.remove('cs-open');
            dialog.remove();
        });

        // Required: Escape does not dismiss it. Browsers may still force it closed
        // on a repeated Escape, so it is reopened until the details are saved.
        dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !finished) e.preventDefault(); });
        dialog.addEventListener('cancel',(e) => { if (!finished) e.preventDefault(); });
        dialog.addEventListener('close', () => {
            if (!finished) dialog.showModal();
        });

        document.body.appendChild(dialog);
        document.body.classList.add('cs-open');
        dialog.showModal();
        return dialog;
    }

    async function init() {
        let user;
        try {
            user = (await apiFetch('/auth/pediatrician/settings')).user;
        } catch (err) {
            console.warn('Consultation setup check failed:', err.message);
            return; // the dashboard works as usual
        }
        if (needsSetup(user)) open(user);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { needsSetup, validate, buildPayload, open, init };
        return;
    }
    init();
})();
