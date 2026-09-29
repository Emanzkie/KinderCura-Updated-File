// RETIRED — this page is no longer part of any sign-up flow.
//
// SIGN-UP,LOGIN/verify-email.html was a standalone mock of the old PIN screen.
// Its script never called the backend: verifyOTP() popped an "Email verified
// successfully!" alert and redirected on sessionStorage.userRole alone, and
// resendOTP() only restarted a countdown. It referenced /api/auth/verify-pin
// and /api/auth/resend-pin, neither of which exists.
//
// Email verification now happens entirely inside SIGN-UP,LOGIN/signup.html
// (steps sp5 for parents and sd4 for pediatricians) against the real endpoints
// POST /api/auth/send-otp and POST /api/auth/verify-otp — see js/auth/signup.js.
//
// Nothing links here any more, but the page is kept reachable by URL, so it
// redirects to the real flow rather than offering a verification screen that
// verifies nothing. The stubs below exist only so an inline handler fired
// before the redirect lands cannot throw.

function moveToNext() {}
function handleBackspace() {}

function verifyOTP(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    window.location.replace('/signup.html');
}

function resendOTP() {
    window.location.replace('/signup.html');
}

window.location.replace('/signup.html');
