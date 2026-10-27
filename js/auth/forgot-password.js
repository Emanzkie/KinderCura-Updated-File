// Forgot password: request an emailed 6-digit code, then set a new password.
// Talks to POST /api/auth/forgot-password and POST /api/auth/reset-password.
(function () {
    const API = window.location.origin + '/api';

    const requestForm = document.getElementById('requestCodeForm');
    const resetForm = document.getElementById('resetPasswordForm');
    const info = document.getElementById('resetInfo');
    const error = document.getElementById('resetError');
    const intro = document.getElementById('resetIntro');
    const emailInput = document.getElementById('resetEmail');

    function show(el, text) {
        el.textContent = text || '';
        el.style.display = text ? 'block' : 'none';
    }

    async function post(path, body) {
        const res = await fetch(`${API}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
        return data;
    }

    async function requestCode() {
        const email = emailInput.value.trim();
        show(error, '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            show(error, 'Please enter a valid email address.');
            emailInput.focus();
            return;
        }
        const btn = document.getElementById('requestCodeBtn');
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
            const data = await post('/auth/forgot-password', { email });
            show(info, data.message);
            intro.textContent = `Enter the code sent to ${email} and choose a new password.`;
            requestForm.style.display = 'none';
            resetForm.style.display = 'block';
            document.getElementById('resetCode').focus();
        } catch (err) {
            show(error, err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Send Reset Code';
        }
    }

    requestForm.addEventListener('submit', (e) => {
        e.preventDefault();
        requestCode();
    });

    document.getElementById('resendCodeLink').addEventListener('click', (e) => {
        e.preventDefault();
        show(info, '');
        resetForm.style.display = 'none';
        requestForm.style.display = 'block';
        requestCode();
    });

    resetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        show(error, '');
        const code = document.getElementById('resetCode').value.trim();
        const password = document.getElementById('resetNewPassword').value;
        const confirm = document.getElementById('resetConfirmPassword').value;

        if (!/^\d{6}$/.test(code)) return show(error, 'Enter the 6-digit code from the email.');
        if (password.length < 8) return show(error, 'Password must be at least 8 characters.');
        if (password !== confirm) return show(error, 'The two passwords do not match.');

        const btn = document.getElementById('resetPasswordBtn');
        btn.disabled = true;
        btn.textContent = 'Resetting…';
        try {
            const data = await post('/auth/reset-password', { email: emailInput.value.trim(), code, password });
            resetForm.style.display = 'none';
            intro.textContent = 'Password updated.';
            show(info, `${data.message || 'Your password has been reset.'} Redirecting to sign in…`);
            setTimeout(() => { window.location.href = '/login'; }, 2500);
        } catch (err) {
            show(error, err.message);
            btn.disabled = false;
            btn.textContent = 'Reset Password';
        }
    });
})();
