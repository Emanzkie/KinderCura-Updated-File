// middleware/auth.js
// Purpose:
// - Verifies the JWT token from Authorization: Bearer <token>
// - Attaches the decoded user info to req.user for downstream routes
// - Provides role-guard helpers: adminOnly, secretaryOrPediatrician
// JWT_SECRET must exist in your .env file

const jwt = require('jsonwebtoken');
const User = require('../models/User');
require('dotenv').config();

// Login refuses these two statuses, so a token must stop working for them too.
// Any account suspended (or a pediatrician sent back to pending after a
// rejected PRC check) after the token was issued would otherwise keep full
// access until it expires — for an admin, that means admin access. Accounts
// with no stored status keep working, as at login.
function blockedStatusMessage(role, status) {
    if (status === 'suspended') return 'Your account has been suspended.';
    if (status === 'pending') {
        return role === 'pediatrician'
            ? 'Your pediatrician account is still pending admin approval.'
            : 'Your account is not yet active. Please contact the clinic administrator.';
    }
    return null;
}

// Re-reads the account behind every token, which the signed token cannot keep
// current: a deleted account, a suspended one, or one whose role changed since
// login is refused here instead of working until the token expires. A
// secretary's token also carries the pediatrician they were linked to at
// login; an admin can unlink or re-link them afterwards, so that is refreshed
// here too and every route that reads req.user.linkedPediatricianId sees the
// current link.
async function requireActiveAccount(req, res, next) {
    const isSecretary = req.user.role === 'secretary';
    let account;
    try {
        account = await User.findById(req.user.userId)
            .select(isSecretary ? 'role status linkedPediatricianId' : 'role status')
            .lean();
    } catch (err) {
        console.error('[auth] Could not check account status:', err && err.message ? err.message : err);
        return res.status(503).json({ error: 'Could not verify your account. Please try again.' });
    }
    if (!account) {
        return res.status(401).json({ error: 'Account not found. Please log in again.' });
    }
    // Role changed since login (e.g. an admin was demoted): the token's role
    // would otherwise keep granting the old permissions.
    if (account.role && account.role !== req.user.role) {
        return res.status(401).json({ error: 'Your account was changed. Please log in again.' });
    }
    const blocked = blockedStatusMessage(req.user.role, account.status);
    if (blocked) {
        return res.status(403).json({ error: blocked });
    }
    if (isSecretary) {
        if (account.linkedPediatricianId) req.user.linkedPediatricianId = String(account.linkedPediatricianId);
        else delete req.user.linkedPediatricianId;
    }
    next();
}

// Important: authMiddleware runs on every protected API endpoint.
// It rejects requests with no token or an expired token.
function authMiddleware(req, res, next) {
    const header = String(req.headers.authorization || '').trim();

    // Accept 'Bearer <token>' case-insensitive and tolerate extra spacing
    let token = null;
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) token = String(m[1] || '').trim();

    // Treat literal strings "null" or "undefined" as missing tokens
    if (!token || token === 'null' || token === 'undefined') {
        return res.status(401).json({ error: 'No token. Please log in.' });
    }

    try {
        // Allow a small clock tolerance when verifying to avoid rejecting near-expiry tokens
        req.user = jwt.verify(token, process.env.JWT_SECRET, { clockTolerance: 120 });
        return requireActiveAccount(req, res, next);
    } catch (err) {
        if (err && err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please log in again.' });
        }
        return res.status(401).json({ error: 'Token invalid. Please log in again.' });
    }
}

// A pediatrician whose PRC check was rejected cannot log in (their account is
// pending again), yet has to be able to resubmit documents. Login hands them a
// short-lived token for that one purpose. It is signed with a different key
// from normal session tokens, so authMiddleware above rejects it everywhere and
// it works only on POST /api/prc/resubmit.
const PRC_RESUBMIT_TTL = '30m';
const prcResubmitKey = () => `${process.env.JWT_SECRET}:prc-resubmit`;

function signPrcResubmitToken(user) {
    return jwt.sign({ userId: String(user._id), purpose: 'prc-resubmit' }, prcResubmitKey(), { expiresIn: PRC_RESUBMIT_TTL });
}

// Runs before the upload middleware, so a request without a valid token never
// gets a file stored.
async function prcResubmitAuth(req, res, next) {
    const m = String(req.headers.authorization || '').trim().match(/^Bearer\s+(.+)$/i);
    let payload;
    try {
        payload = jwt.verify(m ? m[1].trim() : '', prcResubmitKey());
    } catch (err) {
        return res.status(401).json({ error: 'This resubmission link has expired. Please sign in again.' });
    }
    if (payload.purpose !== 'prc-resubmit') {
        return res.status(401).json({ error: 'This resubmission link has expired. Please sign in again.' });
    }

    let account;
    try {
        account = await User.findById(payload.userId).select('role status prcVerificationStatus').lean();
    } catch (err) {
        console.error('[auth] Could not check PRC resubmission account:', err && err.message ? err.message : err);
        return res.status(503).json({ error: 'Could not verify your account. Please try again.' });
    }
    if (!account || account.role !== 'pediatrician'
        || account.status !== 'pending' || account.prcVerificationStatus !== 'rejected') {
        return res.status(403).json({ error: 'This account is not awaiting PRC resubmission.' });
    }
    req.user = { userId: String(payload.userId), role: 'pediatrician' };
    next();
}

// adminOnly — blocks all non-admin users from admin-restricted endpoints.
function adminOnly(req, res, next) {
    if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Admins only.' });
    }
    next();
}

// Important: secretaryOrPediatrician — allows both the pediatrician AND
// their linked secretary to access scheduling endpoints.
// The route itself must still verify that the secretary's linkedPediatricianId
// matches the appointment's pediatricianId before allowing writes.
function secretaryOrPediatrician(req, res, next) {
    const role = req.user?.role;
    if (role !== 'pediatrician' && role !== 'secretary') {
        return res.status(403).json({ error: 'Pediatricians and their secretaries only.' });
    }
    next();
}

module.exports = { authMiddleware, adminOnly, secretaryOrPediatrician, signPrcResubmitToken, prcResubmitAuth };
