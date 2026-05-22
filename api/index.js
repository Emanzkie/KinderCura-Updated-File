// api/index.js — Vercel serverless wrapper for the Express `app`
//
// KEY DESIGN DECISIONS for serverless reliability:
// 1. Use mongoose.connection.readyState instead of a global flag — the flag
//    doesn't persist reliably across Vercel cold starts.
// 2. Add a hard timeout on DB connection so requests never hang if Mongo
//    is unreachable.
// 3. If DB connection fails, return 503 immediately instead of proceeding
//    with a broken database.

const serverless = require('serverless-http');
const { connectDB, mongoose } = require('../db');

// The Express `app` is required here (not at top-level) to avoid circular
// issues and ensure it's only loaded once per cold start.
const app = require('../server');
const handler = serverless(app);

// Hard cap on how long we wait for Mongo before giving up.
// Vercel hobby has a 10 s limit — we spend at most 5 s on DB.
const DB_CONNECT_TIMEOUT_MS = 5000;

/**
 * Resolve the DB connection with a hard timeout.
 * Returns true if connected, false if it failed/timed out.
 */
async function ensureDB() {
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const state = mongoose.connection.readyState;
    if (state === 1) return true;    // Already connected — skip
    if (state === 2) {
        // Currently connecting — wait for it (with timeout)
        try {
            await Promise.race([
                new Promise((resolve) => mongoose.connection.once('connected', resolve)),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('DB connection wait timed out')), DB_CONNECT_TIMEOUT_MS)
                ),
            ]);
            return true;
        } catch (e) {
            console.error('[api/index] Timed out waiting for existing DB connection:', e.message);
            return false;
        }
    }

    // Disconnected or disconnecting — start fresh
    try {
        await Promise.race([
            connectDB({ retries: 2, delayMs: 500 }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('DB connect timed out')), DB_CONNECT_TIMEOUT_MS)
            ),
        ]);
        return true;
    } catch (e) {
        console.error('[api/index] DB connection failed:', e && e.stack ? e.stack : e);
        return false;
    }
}

module.exports = async (req, res) => {
    const dbOk = await ensureDB();

    if (!dbOk) {
        // Return immediately with a clear error instead of proceeding
        // with no database — this prevents silent data-layer hangs.
        console.error(`[api/index] Serving 503 for ${req.method} ${req.url} — DB unavailable`);
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            error: 'Service temporarily unavailable',
            detail: 'Database connection could not be established',
        }));
        return;
    }

    return handler(req, res);
};
