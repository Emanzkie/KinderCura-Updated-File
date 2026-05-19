// middleware/auth.js
// Purpose:
// - Verifies the JWT token from Authorization: Bearer <token>
// - Attaches the decoded user info to req.user for downstream routes
// - Provides role-guard helpers: adminOnly, secretaryOrPediatrician
// JWT_SECRET must exist in your .env file

const jwt = require('jsonwebtoken');
require('dotenv').config();

// Important: authMiddleware runs on every protected API endpoint.
// It rejects requests with no token or an expired token.
function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'No token. Please log in.' });
    }

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET, { clockTolerance: 60 });
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Token invalid or expired. Please log in again.' });
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
