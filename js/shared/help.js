// Help & Support page (/help.html), shared by every role.
// Sets the back link to the signed-in user's dashboard and shows the clinic
// contact the admin saves in System Settings (GET /api/payments/clinic-config).
(function () {
    const DASHBOARDS = {
        admin: '/admin/admin-dashboard.html',
        pediatrician: '/pedia/pediatrician-dashboard',
        secretary: '/secretary/secretary-dashboard.html',
    };

    const user = KC.user();
    const back = document.getElementById('helpBackLink');
    if (user && KC.token()) {
        // Every remaining role (parent, legal_guardian, foster_parent, court_appointed) uses the parent side.
        back.href = DASHBOARDS[user.role] || '/parent/dashboard';
        back.textContent = '← Back to dashboard';
    } else {
        back.textContent = '← Back to sign in';
        return;
    }

    const state = document.getElementById('helpContactState');
    state.textContent = 'Loading contact details…';
    apiFetch('/payments/clinic-config')
        .then((data) => {
            const clinic = (data && data.clinic) || {};
            document.getElementById('helpClinicName').textContent = clinic.clinicName || '—';
            const email = document.getElementById('helpClinicEmail');
            email.textContent = clinic.email || '—';
            if (clinic.email) email.href = 'mailto:' + clinic.email;
            else email.removeAttribute('href');
            document.getElementById('helpClinicPhone').textContent = clinic.phoneNumber || '—';
            document.getElementById('helpClinicAddress').textContent = clinic.address || '—';
            document.getElementById('helpContact').hidden = false;
            state.textContent = '';
        })
        .catch(() => {
            state.textContent = 'Could not load the clinic contact right now. Please try again later.';
        });
})();
