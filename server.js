// Main Express server for KinderCura Step 1 MongoDB migration
// Purpose of this file:
// - connect the app to MongoDB
// - register middleware
// - serve HTML/CSS/icons/uploads
// - mount API routes
const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { connectDB, mongoose } = require('./db');
const sse = require('./sse');
const http = require('http');

const app = express();

// ── Detect Vercel serverless environment ────────────────────────
const IS_VERCEL = !!(process.env.VERCEL || process.env.NOW_REGION);

// ── Serverless safety-timeout middleware ────────────────────────
// Ensures every request sends *some* response before Vercel's
// 10 s (hobby) / 60 s (pro) hard timeout kills the function.
if (IS_VERCEL) {
    app.use((req, res, next) => {
        const SAFETY_MS = 9000; // 9 seconds — well under the 10 s hobby limit
        const timer = setTimeout(() => {
            if (!res.headersSent) {
                console.error(`[TIMEOUT] Request timed out: ${req.method} ${req.originalUrl}`);
                res.status(504).json({ error: 'Request timed out' });
            }
        }, SAFETY_MS);
        res.on('finish', () => clearTimeout(timer));
        res.on('close', () => clearTimeout(timer));
        next();
    });
}

// Allow frontend pages to call the backend API during local development
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Enable EJS view rendering for minimal UI test pages
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
// Serve our local public assets (JS/CSS used by the test pages)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Static folders so the browser can load styles, icons, and uploaded files
app.use('/css', express.static(path.join(__dirname, 'CSS files')));
app.use('/icons', express.static(path.join(__dirname, 'ICONS')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/assets/css', express.static(path.join(__dirname, 'CSS files')));
app.use('/assets/images', express.static(path.join(__dirname, 'ICONS')));
/* Serve JS modules referenced by admin pages */
app.use('/assets/js', express.static(path.join(__dirname, 'assets/js')));
/* Serve role-specific JS from /js/ directory (parent, pedia, admin, secretary, auth) */
app.use('/js', express.static(path.join(__dirname, 'js')));

// Serve root api.js at /api.js (full version with fetchParentChildren, etc.)
app.get('/api.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'api.js'));
});

app.use(express.static(__dirname, { index: false }));
app.use(express.static(path.join(__dirname, 'SIGN-UP,LOGIN')));

// Minimal EJS test routes for guardian UI (rendered pages)
// ⚠️ DEPRECATED — /parent/invite-guardian is the older standalone invite page.
//   All invite/guardian management functionality has moved to /parent/guardians.
//   Kept here for backward compatibility; remove after migration is confirmed.
app.get('/parent/invite-guardian', (req, res) => res.render('parent/invite-guardian'));
app.get('/admin/guardian-management', (req, res) => res.render('admin/guardian-management'));

// ── Explicit parent-page routes ────────────────────────────────
// These MUST appear before /parent/:page so that they are matched
// before the generic catch-all tries to sendFile a non-existent file.

// Guardian Management page (handles /parent/guardians and /parent/guardians.html)
app.get('/parent/guardians', (req, res) => {
  res.sendFile(path.join(__dirname, 'PARENT', 'guardian-management.html'));
});
app.get('/parent/guardians.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'PARENT', 'guardian-management.html'));
});

// Public invitation-acceptance page
// Serves the standalone accept-invitation page (route kept for backward compat;
// email links and direct navigation continue to work as before).
app.get('/parent/accept-invitation', (req, res) => {
  res.sendFile(path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});
app.get('/guardian/accept-invitation', (req, res) => {
  res.sendFile(path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});
// Short friendly route to accept guardian invitations (kept for backward compat).
// Serves the same accept-invitation page so existing email links still work.
app.get('/accept-invitation', (req, res) => {
  res.sendFile(path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});

// Friendly page routes for parent / pedia / admin pages
app.get('/parent/:page', (req, res) => res.sendFile(path.join(__dirname, 'PARENT', req.params.page)));
app.get('/pedia/:page', (req, res) => res.sendFile(path.join(__dirname, 'PEDIA', req.params.page)));

/* Explicit route for PRC Verification clean URL: /admin/prc-verification maps to ADMIN/admin-prc-verification.html */
app.get('/admin/prc-verification', (req, res) => {
    res.sendFile(path.join(__dirname, 'ADMIN', 'admin-prc-verification.html'));
});

app.get('/admin/:page', (req, res) => res.sendFile(path.join(__dirname, 'ADMIN', req.params.page)));
// Important: serves the new SECRETARY HTML pages under /secretary/
app.get('/secretary/:page', (req, res) => res.sendFile(path.join(__dirname, 'SECRETARY', req.params.page)));

// Step 1 routes already converted to MongoDB
app.use('/api/auth', require('./routes/auth'));
app.use('/api/children', require('./routes/children'));
app.use('/api/upload', require('./routes/upload'));

// Remaining routes are still from the older system for now.
// We left them mounted so the project structure stays familiar while migrating step by step.
app.use('/api/admin', require('./routes/admin'));
app.use('/api/assessments', require('./routes/assessments'));
app.use('/api/recommendations', require('./routes/recommendations'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/questions', require('./routes/custom-questions'));
// V2 guardian & audit endpoints (non-breaking and additive)
app.use('/api/v2/guardians', require('./routes/guardians'));
app.use('/api/v2/audit-logs', require('./routes/audit-logs'));
// Important: secretary routes handle secretary-specific profile and admin management endpoints.
app.use('/api/secretary', require('./routes/secretary'));
// ML training & prediction pipeline endpoints.
app.use('/api/ml', require('./routes/ml'));
// PRC License Verification Module — upload, review, and approve PRC documents.
app.use('/api/prc', require('./routes/prc-verification'));

app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', server: 'KinderCura Mongo Step 1', time: new Date() });
});

// SSE is only supported in long-lived server environments.
// In Vercel serverless, SSE connections will time out, so return a
// clear error instead of hanging.
app.get('/api/admin/sse', (req, res) => {
    if (IS_VERCEL) {
        return res.status(501).json({
            error: 'SSE is not supported in serverless environments',
            hint: 'Use polling or a WebSocket service for real-time updates',
        });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sse.addClient(res);

    res.write(': connected\n\n');

    req.on('close', () => {
        sse.removeClient(res);
    });
});

// ── Fast /favicon.ico handler ──────────────────────────────────
// Browsers request /favicon.ico automatically on every page load.
// Without this explicit route the catch-all below would serve
// landing.html, which wastes resources and can cause timeouts
// in serverless environments.
app.get('/favicon.ico', (req, res) => {
    // Try to serve logo.png as favicon; if it fails, return 204 No Content
    const faviconPath = path.join(__dirname, 'ICONS', 'logo.png');
    res.sendFile(faviconPath, (err) => {
        if (err && !res.headersSent) {
            res.status(204).end();
        }
    });
});

// ── Catch-all: serve landing page for navigation requests ──────
// Only serve the landing page for requests that look like page
// navigation (HTML). Reject other unknown paths with 404 to avoid
// wasting serverless execution time on stray asset requests.
app.get('*', (req, res) => {
    // If the request explicitly asks for non-HTML content, 404
    const accept = req.headers.accept || '';
    if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, 'SIGN-UP,LOGIN', 'landing.html'), (err) => {
        if (err && !res.headersSent) {
            console.error('[CATCH-ALL] Failed to serve landing.html:', err.message);
            res.status(500).json({ error: 'Failed to load page' });
        }
    });
});

const PORT = process.env.PORT || 3001;
let server = null;

// Helper: check whether something is already responding on the port
async function checkExistingServer(port) {
    return new Promise((resolve) => {
        const options = {
            hostname: '127.0.0.1',
            port,
            path: '/api/health',
            method: 'GET',
            timeout: 1500,
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const isOur = json && typeof json.server === 'string' && json.server.includes('KinderCura');
                    resolve({ running: true, isOur, info: json });
                } catch (e) {
                    resolve({ running: true, isOur: false, info: data });
                }
            });
        });

        req.on('error', () => resolve({ running: false }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ running: false });
        });
        req.end();
    });
}

// Helper: best-effort find PID listening on a port (Windows and Unix)
async function findPidByPort(port) {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
            const lines = String(stdout).split(/\r?\n/).filter(Boolean);
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (/^\d+$/.test(pid)) return parseInt(pid, 10);
            }
        } else {
            try {
                const { stdout } = await execAsync(`lsof -i :${port} -sTCP:LISTEN -t`);
                const p = String(stdout).split(/\r?\n/).find(Boolean);
                if (p) return parseInt(p, 10);
            } catch (e) {
                const { stdout } = await execAsync(`ss -ltnp | grep :${port}`);
                const m = String(stdout).match(/pid=(\d+),/);
                if (m) return parseInt(m[1], 10);
            }
        }
    } catch (e) {
        return null;
    }
    return null;
}

async function startApp() {
    try {
        await connectDB();

        server = http.createServer(app);

  server.on('error', async (err) => {
        // ── Port already in use ──
        if (err && err.code === 'EADDRINUSE') {
            try {
                const existing = await checkExistingServer(PORT);
                if (existing.running) {
                    if (existing.isOur) {
                        console.log(`ℹ️  A KinderCura server is already running at http://localhost:${PORT} (health OK). Exiting.`);
                        process.exit(0);
                    }
                    console.error(`❌ Port ${PORT} is occupied by another process that responds to /api/health but is not a KinderCura server.`);
                } else {
                    console.error(`❌ Port ${PORT} is occupied and does not respond to /api/health.`);
                }
            } catch {
                console.error(`❌ Port ${PORT} is occupied.`);
            }
            const pid = await findPidByPort(PORT);
            if (pid) {
                console.error(`Process on port ${PORT} has PID ${pid}.`);
                if (process.platform === 'win32') {
                    console.error(`Stop it: Stop-Process -Id ${pid} -Force`);
                } else {
                    console.error(`Stop it: kill ${pid}`);
                }
            }
            process.exit(1);
        }
        // ── Any other server error ──
        console.error('❌ Server error:', err && err.stack ? err.stack : err);
        process.exit(1);
    });

        server.listen(PORT, () => {
            console.log(`\n🚀 KinderCura running → http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('❌ Failed to start application:', err && err.stack ? err.stack : err);
        process.exit(1);
    }
}

// When this file is run directly (node server.js) start the HTTP server.
// When required by a serverless wrapper (for Vercel / functions), export the
// Express `app` instead so the wrapper can handle incoming requests.
if (require.main === module) {
    startApp();
} else {
    module.exports = app;
}

function makeGracefulShutdown(signal) {
    return async () => {
        console.log(`\n⚠️ Received ${signal}. Shutting down gracefully...`);
        try {
            if (server) {
                server.close((err) => {
                    if (err) console.error('Error closing HTTP server:', err);
                });
            }
            if (mongoose && mongoose.connection && mongoose.connection.readyState) {
                await mongoose.disconnect();
                console.log('✅ MongoDB connection closed.');
            }
        } catch (e) {
            console.error('Error during graceful shutdown:', e && e.stack ? e.stack : e);
        } finally {
            process.exit(0);
        }
    };
}

process.on('SIGINT', makeGracefulShutdown('SIGINT'));
process.on('SIGTERM', makeGracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err && err.stack ? err.stack : err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
    if (server) {
        makeGracefulShutdown('unhandledRejection')();
    } else {
        process.exit(1);
    }
});
