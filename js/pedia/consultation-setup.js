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

    const field = (name, label, icon, attrs) => `
        <div class="cs-field">
            <label for="cs-${name}">${label}</label>
            <span class="cs-input"><img src="/icons/${icon}.png" alt=""><input id="cs-${name}" aria-describedby="cs-${name}-err" required ${attrs}></span>
            <p class="cs-err" id="cs-${name}-err"></p>
        </div>`;

    // Decorative only; filled from consultation-setup.css.
    const WAVES = `
        <svg class="cs-waves" viewBox="0 0 340 260" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path class="cs-wave-back" d="M0 178C130 160 190 30 340 0v260H0z"/>
            <path class="cs-wave-front" d="M0 260c130-30 190-138 340-150v150z"/>
        </svg>`;

    const TEMPLATE = `
        <div class="cs-brand">
            <p class="cs-logo"><img src="/icons/logo.png" alt=""> KinderCura</p>
            <h2 id="cs-title" tabindex="-1" autofocus></h2>
            <p class="cs-lead">Set up your consultation details and availability so parents can find you and book their child's appointment.</p>
            ${WAVES}
        </div>
        <div class="cs-main">
            <form id="cs-form" novalidate>
                <h3 class="cs-heading">Consultation Profile</h3>
                <p class="cs-note">Fill in your consultation details to complete your setup.</p>
                <fieldset><legend>Contact Information</legend>
                    <div class="cs-grid">
                        ${field('phoneNumber', 'Phone Number', 'mobile_number', 'type="tel" autocomplete="tel" maxlength="20" placeholder="09123456789"')}
                        ${field('clinicName', 'Clinic Name', 'address', 'type="text" maxlength="120"')}
                        ${field('institution', 'Hospital / Institution Name', 'pediatrician', 'type="text" maxlength="120" placeholder="Enter hospital or institution name"')}
                    </div>
                </fieldset>
                <fieldset><legend>Consultation Details</legend>
                    <div class="cs-grid">
                        ${field('consultationFee', 'Consultation Fee (PHP)', 'consultation_fee', 'type="number" min="1" step="0.01" inputmode="decimal" placeholder="Enter consultation fee"')}
                        ${field('maxPatientsPerDay', 'Maximum Patients per Day', 'maximum_patients', 'type="number" min="1" max="50" step="1" inputmode="numeric"')}
                    </div>
                </fieldset>
                <fieldset><legend>Availability Schedule</legend>
                    <div class="cs-field" role="group" aria-labelledby="cs-days-label" aria-describedby="cs-days-err">
                        <span class="cs-label" id="cs-days-label">Available Days</span>
                        <div class="cs-days">${DAYS.map((d) => `<label><input type="checkbox" name="csDay" value="${d}"><span>${d}</span></label>`).join('')}</div>
                        <p class="cs-err" id="cs-days-err"></p>
                    </div>
                    <div class="cs-grid">
                        ${field('startTime', 'Consultation Start Time', 'pedia_hours', 'type="time"')}
                        ${field('endTime', 'Consultation End Time', 'pedia_hours', 'type="time"')}
                    </div>
                </fieldset>
                <p class="cs-err cs-err--form" id="cs-form-err" role="alert"></p>
                <div class="cs-actions">
                    <button type="button" class="cs-link" id="cs-logout">Log Out</button>
                    <button type="submit" class="btn btn-primary" id="cs-save">Save and Continue</button>
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
                $('save').textContent = 'Save and Continue';
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
