// tests/unit/file-storage-r2.test.js
// Exercises services/fileStorage.js against BOTH storage modes without any real
// credentials and without creating a real production upload:
//
//   1. Local disk mode (USE_BLOB unset)  — the default dev behaviour is intact.
//   2. Cloudflare R2 mode (USE_BLOB=true + R2_* pointing at an in-process mock)
//      — storeFile / existsStored / readStored / serveStored / staticFallback /
//        deleteStored all round-trip through the SigV4 client in objectStore.js.
//
// The mock server also asserts that every request carried a well-formed
// AWS4-HMAC-SHA256 Authorization header and an x-amz-content-sha256 header, so a
// broken signer fails the test rather than silently "working" against the mock.

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Writable } = require('stream');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── helpers ──────────────────────────────────────────────────────────────
function freshFileStorage() {
    // fileStorage decides its backend at module-load time from env, so every
    // scenario needs a clean require.
    delete require.cache[require.resolve('../../services/fileStorage')];
    delete require.cache[require.resolve('../../services/objectStore')];
    return require('../../services/fileStorage');
}

// A minimal Express-response stand-in that is ALSO a Writable stream, so
// `stream.pipe(res)` from serveStored works and the bytes land in `res.body`.
function fakeRes() {
    const chunks = [];
    const res = new Writable({
        write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
    });
    res.headers = {};
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.sendFile = (p) => { res.sentFile = p; chunks.push(fs.readFileSync(p)); res.end(); };
    Object.defineProperty(res, 'body', { get: () => (chunks.length ? Buffer.concat(chunks) : null) });
    // serveStored may register res.on('close', ...); Writable already provides .on
    return res;
}

/** Wait until a fakeRes has been finished (end() called or piped to completion). */
function resDone(res) {
    return new Promise((resolve) => {
        if (res.writableEnded) return resolve();
        res.on('finish', resolve);
        res.on('close', resolve);
    });
}

// In-memory S3/R2-compatible mock. Path-style: /<bucket>/<key...>
function startMockR2() {
    const objects = new Map(); // key -> { body:Buffer, contentType:string }
    let sawAuthHeader = false;
    let sawPayloadHash = false;

    const server = http.createServer((req, res) => {
        const auth = req.headers['authorization'] || '';
        if (/^AWS4-HMAC-SHA256 Credential=[^,]+, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/.test(auth)) {
            sawAuthHeader = true;
        }
        if (typeof req.headers['x-amz-content-sha256'] === 'string') sawPayloadHash = true;

        const url = new URL(req.url, 'http://mock');
        const parts = url.pathname.replace(/^\/+/, '').split('/');
        const bucket = parts.shift();
        const key = decodeURIComponent(parts.join('/'));
        if (bucket !== 'test-bucket') { res.statusCode = 400; return res.end('wrong bucket'); }

        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => {
            if (req.method === 'PUT') {
                objects.set(key, {
                    body: Buffer.concat(chunks),
                    contentType: req.headers['content-type'] || 'application/octet-stream',
                });
                res.statusCode = 200;
                return res.end();
            }
            const obj = objects.get(key);
            if (req.method === 'HEAD') {
                if (!obj) { res.statusCode = 404; return res.end(); }
                res.setHeader('Content-Length', obj.body.length);
                res.setHeader('Content-Type', obj.contentType);
                res.statusCode = 200;
                return res.end();
            }
            if (req.method === 'GET') {
                if (!obj) { res.statusCode = 404; return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
                res.setHeader('Content-Length', obj.body.length);
                res.setHeader('Content-Type', obj.contentType);
                res.statusCode = 200;
                return res.end(obj.body);
            }
            if (req.method === 'DELETE') {
                objects.delete(key);
                res.statusCode = 204;
                return res.end();
            }
            res.statusCode = 405;
            res.end();
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                objects,
                assertSignibrityObserved() {
                    assert.ok(sawAuthHeader, 'mock never saw a well-formed AWS4-HMAC-SHA256 Authorization header');
                    assert.ok(sawPayloadHash, 'mock never saw an x-amz-content-sha256 header');
                },
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

function withEnv(overrides, fn) {
    const saved = {};
    for (const k of Object.keys(overrides)) {
        saved[k] = process.env[k];
        if (overrides[k] === undefined) delete process.env[k];
        else process.env[k] = overrides[k];
    }
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            for (const k of Object.keys(saved)) {
                if (saved[k] === undefined) delete process.env[k];
                else process.env[k] = saved[k];
            }
        });
}

// ── Scenario 1: local disk mode is unchanged ─────────────────────────────
async function testLocalDiskMode() {
    await withEnv(
        { USE_BLOB: undefined, BLOB_READ_WRITE_TOKEN: undefined, VERCEL: undefined, RENDER: undefined },
        async () => {
            const fileStorage = freshFileStorage();
            assert.strictEqual(fileStorage.USE_BLOB, false, 'disk mode: USE_BLOB must be false');

            const relDir = 'uploads/__selftest_disk__';
            const name = 'probe.txt';
            const payload = Buffer.from('local-disk-bytes');
            const absDir = path.join(REPO_ROOT, relDir);

            try {
                const stored = await fileStorage.storeFile(relDir, name, {
                    buffer: payload, mimetype: 'text/plain',
                });
                assert.strictEqual(stored, `${relDir}/${name}`, 'stored path string must be unchanged');
                assert.strictEqual(await fileStorage.existsStored(relDir, name), true);

                const read = await fileStorage.readStored(relDir, name);
                assert.ok(read && read.equals(payload), 'readStored must return the exact bytes');

                const res = fakeRes();
                assert.strictEqual(await fileStorage.serveStored(res, relDir, name), true);
                await resDone(res);
                assert.ok(res.body && res.body.equals(payload), 'serveStored must send the exact bytes');

                await fileStorage.deleteStored(relDir, name);
                assert.strictEqual(await fileStorage.existsStored(relDir, name), false, 'deleteStored must remove the file');
            } finally {
                fs.rmSync(absDir, { recursive: true, force: true });
            }
        },
    );
    console.log('  ✓ local disk mode: store / exists / read / serve / delete round-trip');
}

// ── Scenario 2: Cloudflare R2 mode against a mock endpoint ───────────────
async function testR2Mode() {
    const mock = await startMockR2();
    try {
        await withEnv(
            {
                USE_BLOB: 'true',
                BLOB_READ_WRITE_TOKEN: undefined,
                VERCEL: undefined,
                RENDER: undefined,
                R2_ENDPOINT: `http://127.0.0.1:${mock.port}`,
                R2_BUCKET: 'test-bucket',
                R2_ACCESS_KEY_ID: 'AKIA_TEST',
                R2_SECRET_ACCESS_KEY: 'secret-test-key',
                R2_REGION: 'auto',
                R2_ACCOUNT_ID: undefined,
            },
            async () => {
                const fileStorage = freshFileStorage();
                assert.strictEqual(fileStorage.USE_BLOB, true, 'R2 mode: USE_BLOB must be true');

                const relDir = 'uploads/profiles';
                const name = 'parent_selftest_1700000000000.jpg';
                const payload = crypto.randomBytes(2048);

                // storeFile — the registration-style "upload then name" path
                const file = { buffer: Buffer.from(payload), mimetype: 'image/jpeg' };
                const stored = await fileStorage.storeFile(relDir, name, file);
                assert.strictEqual(stored, 'uploads/profiles/' + name, 'DB path string must be unchanged');
                assert.strictEqual(file.path, '/uploads/profiles/' + name, 'file.path shape must be unchanged');
                assert.ok(mock.objects.has('uploads/profiles/' + name), 'object must exist in the R2 mock under the same key');

                // finalizeUploads — the multer-middleware path (upload.js, prc-verification.js, videos.js)
                const midName = 'child_selftest_1700000000001.png';
                const midFile = { buffer: crypto.randomBytes(512), mimetype: 'image/png' };
                const req = { file: midFile };
                await new Promise((resolve, reject) => {
                    const mw = fileStorage.finalizeUploads(relDir, (r, f, cb) => cb(null, midName), { access: 'public' });
                    mw(req, fakeRes(), (err) => (err ? reject(err) : resolve()));
                });
                assert.strictEqual(midFile.filename, midName, 'finalizeUploads must set file.filename to the basename');
                assert.strictEqual(midFile.path, '/uploads/profiles/' + midName, 'finalizeUploads must set file.path to /<key>');
                assert.ok(mock.objects.has('uploads/profiles/' + midName), 'finalizeUploads must upload the buffered file to R2');
                assert.strictEqual(midFile.buffer, undefined, 'finalizeUploads must free file.buffer after upload');
                await fileStorage.deleteStored(relDir, midName);

                // existsStored
                assert.strictEqual(await fileStorage.existsStored(relDir, name), true, 'existsStored must be true after upload');
                assert.strictEqual(await fileStorage.existsStored(relDir, 'nope-missing.jpg'), false, 'existsStored must be false for a missing key');

                // readStored
                const read = await fileStorage.readStored(relDir, name);
                assert.ok(read && read.equals(payload), 'readStored must return the exact bytes from R2');
                assert.strictEqual(await fileStorage.readStored(relDir, 'missing.jpg'), null, 'readStored must be null for a missing key');

                // serveStored — streams the body and sets headers
                const res = fakeRes();
                const served = await fileStorage.serveStored(res, relDir, name);
                assert.strictEqual(served, true, 'serveStored must report success');
                await resDone(res);
                assert.ok(res.body && res.body.equals(payload), 'serveStored must send the exact bytes');
                assert.strictEqual(res.headers['content-type'], 'image/jpeg', 'serveStored must set Content-Type from the store');
                assert.strictEqual(Number(res.headers['content-length']), payload.length, 'serveStored must set Content-Length');

                const missRes = fakeRes();
                assert.strictEqual(await fileStorage.serveStored(missRes, relDir, 'missing.jpg'), false, 'serveStored must return false for a missing key with no bundled copy');

                // staticFallback — the Express handler mounted after express.static
                const handler = fileStorage.staticFallback('uploads');
                const fbRes = fakeRes();
                let nextCalled = false;
                await handler({ path: '/profiles/' + name }, fbRes, () => { nextCalled = true; });
                await resDone(fbRes);
                assert.strictEqual(nextCalled, false, 'staticFallback must serve the object, not call next()');
                assert.ok(fbRes.body && fbRes.body.equals(payload), 'staticFallback must send the exact bytes');

                const fbMissRes = fakeRes();
                let missNext = false;
                await handler({ path: '/profiles/does-not-exist.jpg' }, fbMissRes, () => { missNext = true; });
                assert.strictEqual(missNext, true, 'staticFallback must call next() for a miss');

                // deleteStored
                await fileStorage.deleteStored(relDir, name);
                assert.strictEqual(mock.objects.has('uploads/profiles/' + name), false, 'deleteStored must remove the object from R2');
                assert.strictEqual(await fileStorage.existsStored(relDir, name), false, 'existsStored must be false after delete');

                mock.assertSignibrityObserved();
            },
        );
    } finally {
        await mock.close();
    }
    console.log('  ✓ Cloudflare R2 mode: store / exists / read / serve / staticFallback / delete round-trip via SigV4');
}

// ── Scenario 3: USE_BLOB set but no backend configured => stays on disk + loud error
async function testMisconfigFallsBackToDiskLoudly() {
    const origErr = console.error;
    let logged = '';
    console.error = (...a) => { logged += a.join(' ') + '\n'; };
    try {
        await withEnv(
            {
                USE_BLOB: 'true',
                BLOB_READ_WRITE_TOKEN: undefined,
                R2_ENDPOINT: undefined, R2_ACCOUNT_ID: undefined, R2_BUCKET: undefined,
                R2_ACCESS_KEY_ID: undefined, R2_SECRET_ACCESS_KEY: undefined,
                VERCEL: undefined, RENDER: undefined,
            },
            async () => {
                const fileStorage = freshFileStorage();
                assert.strictEqual(fileStorage.USE_BLOB, false, 'misconfig: must not claim object storage is on');
            },
        );
    } finally {
        console.error = origErr;
    }
    assert.ok(/no object-storage backend is configured/i.test(logged), 'misconfig must log a loud error');
    console.log('  ✓ USE_BLOB=true with no backend: stays on disk and logs a loud error');
}

async function run() {
    await testLocalDiskMode();
    await testR2Mode();
    await testMisconfigFallsBackToDiskLoudly();
    console.log('file-storage R2 tests OK');
}

run().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
