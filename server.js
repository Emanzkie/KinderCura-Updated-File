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
        const SAFETY_MS = 9500; // 9.5 seconds — gives cold-start DB connect more room under 10 s hobby limit
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

// ── DB connection middleware for serverless ──────────────────────
// Ensures MongoDB is connected before processing any /api/* request.
// In Vercel serverless, connectDB() in api/index.js runs without await
// so the first request could arrive before the connection is ready.
if (IS_VERCEL) {
    app.use('/api', async (req, res, next) => {
        if (mongoose.connection.readyState !== 1) {
            try {
                await connectDB();
            } catch (err) {
                console.error('[DB] Connection failed for', req.method, req.originalUrl, err?.stack || err);
                if (!res.headersSent) {
                    return res.status(503).json({ error: 'Database is temporarily unavailable. Please try again.' });
                }
            }
        }
        next();
    });
}

// Allow frontend pages to call the backend API during local development
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
// The PayMongo webhook signature is an HMAC over the exact bytes PayMongo
// sent. Re-serialising the parsed object produces different bytes and would
// fail every legitimate signature, so the raw buffer is stashed here — only
// for the webhook path, to avoid holding a copy of every request body.
app.use(express.json({
    verify: (req, _res, buf) => {
        if (req.originalUrl && req.originalUrl.startsWith('/api/payments/webhook/')) {
            req.rawBody = buf;
        }
    },
}));
app.use(express.urlencoded({ extended: true }));

// Uploaded files are only on the local filesystem during development. On
// Vercel the deployment is read-only, so anything uploaded after deploy lives
// in Vercel Blob. Each express.static mount below keeps serving the copies
// bundled with the deployment; these fallbacks catch the misses and stream
// them out of the blob store. Registered before the static mounts so ordering
// stays obvious — each handler calls next() when it is not the blob case.
const fileStorage = require('./services/fileStorage');

// ── Cache headers for the app's own static files ────────────────
// express.static defaults to "max-age=0", so browsers re-requested every
// stylesheet, script and icon on every page view, and on Vercel each of those
// requests started the serverless function. s-maxage lets Vercel's CDN keep
// the file until the next deploy (Vercel purges its cache on every deploy),
// while the short browser max-age keeps an already-open tab from holding an
// old script for long after a deploy. HTML is always revalidated by the
// browser so a deploy shows up on the next page view.
// Uploads are left alone: users can replace or delete them at the same URL.
// /api responses never pass through here and stay uncached.
const ONE_YEAR = 31536000;
const CACHE_RULES = [
    [/\.(css|js)$/i, `public, max-age=600, s-maxage=${ONE_YEAR}, stale-while-revalidate=86400`],
    [/\.(png|jpe?g|gif|svg|webp|ico|woff2?)$/i, `public, max-age=86400, s-maxage=${ONE_YEAR}`],
    [/\.html$/i, `public, max-age=0, must-revalidate, s-maxage=${ONE_YEAR}`],
];
const UPLOADS_PATH = /(^|[\\/])uploads([\\/]|$)/i;

function cacheControlFor(filePath) {
    if (UPLOADS_PATH.test(path.relative(__dirname, filePath))) return null;
    const rule = CACHE_RULES.find(([pattern]) => pattern.test(filePath));
    return rule ? rule[1] : null;
}

// For express.static: send() keeps a Cache-Control that is already set.
function setCacheHeaders(res, filePath) {
    const value = cacheControlFor(filePath);
    if (value) res.setHeader('Cache-Control', value);
}
const cachedStatic = (dir, options = {}) => express.static(dir, { ...options, setHeaders: setCacheHeaders });

// For res.sendFile: `headers` is only applied when the file is actually sent,
// so a 404 or error response is never cached.
function sendFileOptions(filePath, options = {}) {
    const value = cacheControlFor(filePath);
    return value ? { ...options, headers: { 'Cache-Control': value } } : options;
}
function sendPage(res, filePath) {
    res.sendFile(filePath, sendFileOptions(filePath));
}

// Enable EJS view rendering for minimal UI test pages
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
// Serve our local public assets (JS/CSS used by the test pages)
app.use('/public', cachedStatic(path.join(__dirname, 'public')));

// Static folders so the browser can load styles, icons, and uploaded files
app.use('/css', cachedStatic(path.join(__dirname, 'CSS files')));
app.use('/icons', cachedStatic(path.join(__dirname, 'ICONS')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/uploads', fileStorage.staticFallback('uploads'));
app.use('/public/uploads', fileStorage.staticFallback('public/uploads'));
app.use('/assets/css', cachedStatic(path.join(__dirname, 'CSS files')));
app.use('/assets/images', cachedStatic(path.join(__dirname, 'ICONS')));
/* Serve JS modules referenced by admin pages */
app.use('/assets/js', cachedStatic(path.join(__dirname, 'assets/js')));
/* Serve role-specific JS from /js/ directory (parent, pedia, admin, secretary, auth) */
app.use('/js', cachedStatic(path.join(__dirname, 'js')));

// Serve root api.js at /api.js (full version with fetchParentChildren, etc.)
app.get('/api.js', (req, res) => {
    sendPage(res, path.join(__dirname, 'api.js'));
});

// Serving the project root is what makes root-level browser assets such as
// /notifications-card-ui.css, /constants/scoring.js and "/CSS files/..." load.
// Left unguarded it also hands out the backend source — /server.js, /db.js and
// /routes/auth.js were all downloadable in production. These two patterns skip
// the root static handler for anything that only the server should read, so
// such a request falls through to the catch-all like any other unknown path.
// Everything the browser genuinely uses is either mounted above or allowed here.
const SERVER_ONLY_DIRS = /^\/(routes|models|controllers|middleware|services|ml|scripts|tests|node_modules|api|views|private|backups|mongodump-kindercura|database|docs)(\/|$)/i;
const SERVER_ONLY_FILES = /^\/(server|db|sse|seed-admin|test-email|preload-dns|api)\.js$|^\/package(-lock)?\.json$|^\/vercel\.json$/i;

// The patterns must be tested against the file express.static will actually
// open, not the raw URL: static decodes %2F (and %5C on Windows) and then
// collapses "..", so "/x/..%2Froutes%2Fauth.js" passed a raw-path check and was
// served as /routes/auth.js. Undecodable paths are left for static to reject.
function rootStaticTarget(urlPath) {
    try {
        return path.posix.normalize('/' + decodeURIComponent(urlPath).replace(/\\/g, '/'));
    } catch {
        return null;
    }
}

const rootStatic = cachedStatic(__dirname, { index: false });
app.use((req, res, next) => {
    const target = rootStaticTarget(req.path);
    if (target === null || SERVER_ONLY_DIRS.test(target) || SERVER_ONLY_FILES.test(target)) return next();
    rootStatic(req, res, next);
});
app.use(cachedStatic(path.join(__dirname, 'SIGN-UP,LOGIN')));

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
  sendPage(res, path.join(__dirname, 'PARENT', 'guardian-management.html'));
});
app.get('/parent/guardians.html', (req, res) => {
  sendPage(res, path.join(__dirname, 'PARENT', 'guardian-management.html'));
});

// Public invitation-acceptance page
// Serves the standalone accept-invitation page (route kept for backward compat;
// email links and direct navigation continue to work as before).
app.get('/parent/accept-invitation', (req, res) => {
  sendPage(res, path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});
app.get('/guardian/accept-invitation', (req, res) => {
  sendPage(res, path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});
// Short friendly route to accept guardian invitations (kept for backward compat).
// Serves the same accept-invitation page so existing email links still work.
app.get('/accept-invitation', (req, res) => {
  sendPage(res, path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});

// Payment page — parent selects walk-in or e-wallet after booking.
// Must stay above /parent/:page: the generic handler would match "payment",
// try to send PARENT/payment (no extension), and 404 the clean URL.
app.get('/parent/payment', (req, res) => {
  sendPage(res, path.join(__dirname, 'PARENT', 'payment.html'));
});

// Role page folders are served by bare file name. The name comes straight from
// the URL, and Express decodes %2F before routing, so "/parent/..%2Fserver.js"
// arrived here as "../server.js" — path.join resolved it to the project root
// and handed out backend source and private/payment-proofs images even with
// the SERVER_ONLY_* guard above fixed. Every file in these folders is a flat .html
// page, so anything else is refused, and `root` makes send() reject traversal
// as a second line of defence.
const PAGE_NAME = /^[A-Za-z0-9_-]+\.html$/;
function servePage(dir) {
    const root = path.join(__dirname, dir);
    return (req, res, next) => {
        const page = req.params.page;
        if (!PAGE_NAME.test(page)) return res.status(404).send('Not found');
        res.sendFile(page, sendFileOptions(path.join(root, page), { root }), (err) => {
            if (!err || res.headersSent) return;
            if (err.status === 404) return res.status(404).send('Not found');
            next(err);
        });
    };
}

// Friendly page routes for parent / pedia / admin pages
app.get('/parent/:page', servePage('PARENT'));
app.get('/pedia/:page', servePage('PEDIA'));

// Admin payment verification page — review e-wallet proofs
app.get('/admin/payments', (req, res) => {
  sendPage(res, path.join(__dirname, 'ADMIN', 'admin-payments.html'));
});

/* Explicit route for PRC Verification clean URL: /admin/prc-verification maps to ADMIN/admin-prc-verification.html */
app.get('/admin/prc-verification', (req, res) => {
    sendPage(res, path.join(__dirname, 'ADMIN', 'admin-prc-verification.html'));
});

app.get('/admin/:page', servePage('ADMIN'));
// Important: serves the new SECRETARY HTML pages under /secretary/
app.get('/secretary/:page', servePage('SECRETARY'));

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
app.use('/api/payments', require('./routes/payments'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/videos', require('./routes/videos'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/questions', require('./routes/custom-questions'));
// Longitudinal pediatrician check-up / medical-history records — a
// dedicated resource separate from Assessment's per-screening diagnosis
// fields. See routes/checkups.js header and models/PediatricianCheckup.js.
app.use('/api/checkups', require('./routes/checkups'));
// Parent-scoped read-only views. Currently the child progress report; this is
// the namespace for future parent-facing aggregate endpoints.
app.use('/api/parent', require('./routes/parent-reports'));
// Pediatrician-scoped read-only reporting over their own patients' screenings.
// Descriptive counts over stored scores — see routes/pedia-reports.js header.
app.use('/api/pedia-reports', require('./routes/pedia-reports'));
// Admin-scoped read-only reporting across the whole system: user and child
// demographics, descriptive screening counts, and screening-vs-review
// concordance — see routes/admin-reports.js header.
app.use('/api/admin-reports', require('./routes/admin-reports'));
// Admin-scoped CENTRALIZED PATIENT REPORTS pivot: one place to browse the
// same stored assessment/review data Parent Reports and Pediatrician Reports
// already show, filterable by pediatrician/parent/child/date — backs the new
// section on the existing ADMIN/admin-reports.html page. See
// routes/admin-patient-reports.js header.
app.use('/api/admin/patient-reports', require('./routes/admin-patient-reports'));
// Registered clinics, pediatrician links and per-clinic transactions — see
// routes/admin-clinics.js header.
app.use('/api/admin/clinics', require('./routes/admin-clinics'));
// V2 guardian & audit endpoints (non-breaking and additive)
app.use('/api/v2/guardians', require('./routes/guardians'));
app.use('/api/v2/audit-logs', require('./routes/audit-logs'));
// Important: secretary routes handle secretary-specific profile and admin management endpoints.
app.use('/api/secretary', require('./routes/secretary'));
// ML training & prediction pipeline endpoints.
app.use('/api/ml', require('./routes/ml'));
// PRC License Verification Module — upload, review, and approve PRC documents.
app.use('/api/prc', require('./routes/prc-verification'));

// Reports only WHETHER each required variable is present, never its value, so a
// deployment missing MONGODB_URI / JWT_SECRET / EMAIL_USER / EMAIL_PASS can be
// identified from the browser instead of by watching a signup fail.
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        server: 'KinderCura Mongo Step 1',
        time: new Date(),
        db: mongoose.connection.readyState === 1 ? 'connected' : 'not-connected',
        env: {
            MONGODB_URI: Boolean(process.env.MONGODB_URI),
            JWT_SECRET: Boolean(process.env.JWT_SECRET),
            EMAIL_USER: Boolean(process.env.EMAIL_USER),
            EMAIL_PASS: Boolean(process.env.EMAIL_PASS),
        },
    });
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
    res.sendFile(faviconPath, sendFileOptions(faviconPath), (err) => {
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
    // An unmatched /api/* path is always a bug, never a page navigation.
    // Previously it fell through to landing.html with HTTP 200, because
    // browser fetch() sends "Accept: */*" and passed the check below. The
    // frontend's apiFetch then saw res.ok === true, failed to parse the HTML
    // as JSON, and silently returned {} — so a wrong endpoint rendered an
    // empty widget with no error anywhere. Answer honestly instead.
    if (req.path === '/api' || req.path.startsWith('/api/')) {
        return res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
    }

    // If the request explicitly asks for non-HTML content, 404
    const accept = req.headers.accept || '';
    if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
        return res.status(404).json({ error: 'Not found' });
    }
    // Only "/" itself is CDN-cached. Any other unknown path also lands here,
    // and that URL may answer JSON for a non-HTML Accept header above.
    const landing = path.join(__dirname, 'SIGN-UP,LOGIN', 'landing.html');
    res.sendFile(landing, req.path === '/' ? sendFileOptions(landing) : {}, (err) => {
        if (err && !res.headersSent) {
            console.error('[CATCH-ALL] Failed to serve landing.html:', err.message);
            res.status(500).json({ error: 'Failed to load page' });
        }
    });
});

const PORT = Number(process.env.PORT) || 3001;
const HOST = '0.0.0.0';
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

        server.listen(PORT, HOST, () => {
            const address = server.address();
            const boundHost = address && typeof address === 'object' ? address.address : HOST;
            const boundPort = address && typeof address === 'object' ? address.port : PORT;
            console.log(`\n🚀 KinderCura running on ${boundHost}:${boundPort}`);
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
