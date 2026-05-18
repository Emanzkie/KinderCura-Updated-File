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

// Serve root api.js at /api.js (full version with fetchParentChildren, etc.)
app.get('/api.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'api.js'));
});

app.use(express.static(__dirname, { index: false }));
app.use(express.static(path.join(__dirname, 'SIGN-UP,LOGIN')));

// Minimal EJS test routes for guardian UI (rendered pages)
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
// Authentication-gated by the page itself; route is always accessible.
app.get('/parent/accept-invitation', (req, res) => {
  res.sendFile(path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});
app.get('/guardian/accept-invitation', (req, res) => {
  res.sendFile(path.join(__dirname, 'PARENT', 'accept-invitation.html'));
});
// Short friendly route to accept guardian invitations (kept for backward compat)
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

app.get('/api/admin/sse', (req, res) => {
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'SIGN-UP,LOGIN', 'landing.html'));
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

startApp();

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
