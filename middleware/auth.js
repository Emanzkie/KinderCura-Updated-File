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
// A pediatrician who is pending (new, or sent back after a rejected PRC check)
// or suspended after the token was issued would otherwise keep full access
// until it expires. Accounts with no stored status keep working, as at login.
const BLOCKED_STATUS_MESSAGES = {
    pending: 'Your pediatrician account is still pending admin approval.',
    suspended: 'Your account has been suspended.',
};

// Re-reads a pediatrician's account status, which the signed token cannot
// reflect. Only this role is checked, so every other role keeps the
// no-database-lookup path.
async function requireActivePediatrician(req, res, next) {
    let account;
    try {
        account = await User.findById(req.user.userId).select('status').lean();
    } catch (err) {
        console.error('[auth] Could not check account status:', err && err.message ? err.message : err);
        return res.status(503).json({ error: 'Could not verify your account. Please try again.' });
    }
    if (!account) {
        return res.status(401).json({ error: 'Account not found. Please log in again.' });
    }
    const blocked = BLOCKED_STATUS_MESSAGES[account.status];
    if (blocked) {
        return res.status(403).json({ error: blocked });
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
        if (req.user.role === 'pediatrician') return requireActivePediatrician(req, res, next);
        next();
    } catch (err) {
        if (err && err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired. Please log in again.' });
        }
        return res.status(401).json({ error: 'Token invalid. Please log in again.' });
    }
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

module.exports = { authMiddleware, adminOnly, secretaryOrPediatrician };
