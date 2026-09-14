// services/fileStorage.js
// Purpose:
// - give every upload route one place to decide where a file physically lives
// - keep local development byte-for-byte identical to how it worked before
// - make uploads survive on hosts with an ephemeral filesystem (Render Free,
//   Vercel, Fly, …) by pushing them to object storage instead of local disk
//
// Locally (default), uploads keep going to the same folders under the project
// root and multer keeps using diskStorage, so nothing about the dev workflow
// changes. When object storage is enabled, multer buffers the file in memory
// and this module pushes it to the configured backend under the *same* relative
// path (e.g. `uploads/profiles/x.jpg`). Because the stored path is unchanged,
// existing DB records and existing frontend <img src="/uploads/..."> URLs keep
// working with no migration.
//
// The store is PRIVATE, so no uploaded file is reachable by a bucket URL.
// Everything is read back through this module, and the routes apply their own
// auth checks first — PRC ID cards, e-wallet payment proofs and ML training
// datasets are only ever streamed to an admin. Profile photos and videos are
// served the same way, proxied through Express rather than fetched from a CDN.
//
// ── Enabling object storage (host-independent) ─────────────────────────────
// Set USE_BLOB=true and configure ONE backend:
//   • Cloudflare R2 (recommended, works anywhere): R2_ENDPOINT (or R2_ACCOUNT_ID)
//     + R2_BUCKET + R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY  — see services/objectStore.js
//   • Vercel Blob (legacy): BLOB_READ_WRITE_TOKEN
// The switch deliberately does NOT look at process.env.VERCEL, so Render (and
// any other host) can turn object storage on. A Vercel deployment that already
// set VERCEL + BLOB_READ_WRITE_TOKEN keeps working without USE_BLOB for
// backward compatibility.

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Readable } = require('stream');
const r2 = require('./objectStore'); // pure module: no network / no throw on require

const PROJECT_ROOT = path.join(__dirname, '..');

// ── Backend selection ─────────────────────────────────────────────────────
const STORAGE_MODE_ON = /^(1|true|yes|on)$/i.test(String(process.env.USE_BLOB || '').trim());
const HAS_R2 = r2.isConfigured();
const HAS_VERCEL_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
// Backward compatibility: an existing Vercel deployment that relied on
// `VERCEL` + a Blob token keeps object storage on without setting USE_BLOB.
const LEGACY_VERCEL_BLOB = !!(process.env.VERCEL || process.env.NOW_REGION) && HAS_VERCEL_BLOB;

const BACKEND =
    (STORAGE_MODE_ON && HAS_R2) ? 'r2'
    : ((STORAGE_MODE_ON || LEGACY_VERCEL_BLOB) && HAS_VERCEL_BLOB) ? 'vercel'
    : null;

// Exported truthy/falsy flag. Callers use it to decide whether to try the
// object store before falling back to bundled-on-disk copies.
const USE_BLOB = BACKEND !== null;

if (STORAGE_MODE_ON && !USE_BLOB) {
    console.error(
        '[fileStorage] USE_BLOB is set but no object-storage backend is configured. ' +
        'Configure Cloudflare R2 (R2_ENDPOINT/R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY) or Vercel Blob (BLOB_READ_WRITE_TOKEN). ' +
        'Until then, uploads are written to the LOCAL FILESYSTEM and will NOT survive ' +
        'a restart, redeploy or spin-down on an ephemeral host.'
    );
} else if (!USE_BLOB && (process.env.RENDER || process.env.FLY_APP_NAME)) {
    console.warn(
        '[fileStorage] Object storage is OFF on an ephemeral host. Uploaded files ' +
        '(profile photos, PRC documents, payment proofs, ML datasets) will be lost on ' +
        'the next restart/redeploy. Set USE_BLOB=true and configure Cloudflare R2.'
    );
} else if (BACKEND === 'r2') {
    console.log(`[fileStorage] Object storage backend: Cloudflare R2. ${r2.describe()}`);
} else if (BACKEND === 'vercel') {
    console.log('[fileStorage] Object storage backend: Vercel Blob.');
}

// The store is PRIVATE. The per-call `access` hint the routes pass is a
// statement of intent, not something a single-bucket backend can vary per file.
const BLOB_ACCESS = process.env.BLOB_STORE_ACCESS === 'public' ? 'public' : 'private';

// `@vercel/blob` is only require()d when that backend is actually selected, so
// local development and local tests never need the package resolved at startup.
function vercelBlob() {
    // eslint-disable-next-line global-require
    return require('@vercel/blob');
}

// ── Normalized object-storage interface ───────────────────────────────────
// Both backends expose the same operations so the rest of this file has
// exactly one code path for "object storage":
//   put(key, buffer, contentType) -> { url }
//   head(key)                     -> { size, contentType } | null   (null = absent)
//   getBuffer(key)                -> { buffer, contentType, size } | null
//   getStream(key)                -> { stream, contentType, size } | null   (no buffering)
//   del(key)                      -> void   (best effort; missing object is ok)
function makeVercelAdapter() {
    return {
        async put(key, buffer, contentType) {
            const { put } = vercelBlob();
            const result = await put(key, buffer, {
                access: BLOB_ACCESS,
                contentType,
                addRandomSuffix: false,
                allowOverwrite: true,
            });
            return { url: result.url };
        },
        async head(key) {
            try {
                const { head } = vercelBlob();
                const info = await head(key, { access: BLOB_ACCESS });
                return { size: info?.size || 0, contentType: info?.contentType || null };
            } catch {
                return null;
            }
        },
        async getStream(key) {
            try {
                const { get } = vercelBlob();
                const result = await get(key, { access: BLOB_ACCESS });
                if (!result || !result.stream) return null;
                return {
                    stream: Readable.fromWeb(result.stream),
                    contentType: result.blob?.contentType || null,
                    size: result.blob?.size || null,
                };
            } catch {
                return null;
            }
        },
        async getBuffer(key) {
            const got = await this.getStream(key);
            if (!got) return null;
            const chunks = [];
            for await (const chunk of got.stream) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            return { buffer, contentType: got.contentType, size: got.size || buffer.length };
        },
        async del(key) {
            try {
                const { del } = vercelBlob();
                await del(key, { access: BLOB_ACCESS });
            } catch { /* ignore */ }
        },
    };
}

const store =
    BACKEND === 'r2' ? r2.client()
    : BACKEND === 'vercel' ? makeVercelAdapter()
    : null;

/** Absolute on-disk directory for a project-relative upload folder. */
function localDir(relDir) {
    const dir = path.join(PROJECT_ROOT, relDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/** Blob object key for a stored file. Always forward slashes. */
function blobKey(relDir, filename) {
    return `${String(relDir).replace(/\\/g, '/').replace(/^\/|\/$/g, '')}/${path.basename(filename)}`;
}

/**
 * multer storage for an upload route.
 * @param {string} relDir project-relative folder, e.g. 'uploads/profiles'
 * @param {(req, file, cb) => void} filenameFn the route's existing filename fn
 */
function makeStorage(relDir, filenameFn) {
    if (USE_BLOB) {
        // The filename fn still runs, in finalizeUploads, so names are unchanged.
        return multer.memoryStorage();
    }
    return multer.diskStorage({
        destination: (_req, _file, cb) => {
            try {
                cb(null, localDir(relDir));
            } catch (err) {
                cb(err);
            }
        },
        filename: filenameFn,
    });
}

/**
 * Express middleware to place immediately AFTER a multer middleware.
 * On disk-backed runs it does nothing. On Blob-backed runs it names each
 * buffered file with the route's own filename function, uploads it, and fills
 * in `file.filename` / `file.path` so downstream route code is unchanged.
 *
 * @param {string} relDir project-relative folder
 * @param {(req, file, cb) => void} filenameFn same fn passed to makeStorage
 * @param {{ access?: 'public'|'private' }} opts
 */
function finalizeUploads(relDir, filenameFn, { access = 'public' } = {}) {
    return async function finalize(req, res, next) {
        if (!USE_BLOB) return next();

        const files = [];
        if (req.file) files.push(req.file);
        if (Array.isArray(req.files)) files.push(...req.files);
        else if (req.files && typeof req.files === 'object') {
            for (const list of Object.values(req.files)) {
                if (Array.isArray(list)) files.push(...list);
            }
        }
        if (!files.length) return next();

        try {
            for (const file of files) {
                const name = await new Promise((resolve, reject) => {
                    filenameFn(req, file, (err, generated) => (err ? reject(err) : resolve(generated)));
                });
                const key = blobKey(relDir, name);
                const result = await store.put(key, file.buffer, file.mimetype);
                // Shape the object like a diskStorage result so routes that read
                // `file.filename` / `file.path` keep working untouched.
                file.filename = path.basename(name);
                file.destination = relDir;
                file.path = `/${key}`;
                file.blobUrl = result.url;
                delete file.buffer; // free the memory before the handler runs
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

/**
 * Commit an uploaded file under its final folder and name.
 *
 * Registration cannot know the final name until the user document exists, so
 * those routes upload first and name afterwards. On disk that is a rename; on
 * Blob the bytes are still in memory and this is the only write that happens,
 * which avoids a pointless upload-then-rename round trip.
 *
 * @returns {Promise<string>} the stored path, e.g. 'uploads/prc-documents/x.jpg'
 */
async function storeFile(relDir, filename, file, { access = 'public' } = {}) {
    const safeName = path.basename(filename);
    const stored = `${relDir}/${safeName}`;

    if (USE_BLOB) {
        if (!file.buffer) throw new Error(`No buffered data for upload ${safeName}`);
        const result = await store.put(blobKey(relDir, safeName), file.buffer, file.mimetype);
        file.filename = safeName;
        file.path = `/${stored}`;
        file.blobUrl = result.url;
        delete file.buffer;
        return stored;
    }

    const finalPath = path.join(localDir(relDir), safeName);
    if (file.buffer) {
        fs.writeFileSync(finalPath, file.buffer);
    } else if (file.path && path.resolve(file.path) !== path.resolve(finalPath)) {
        fs.renameSync(file.path, finalPath);
    }
    file.path = finalPath;
    file.filename = safeName;
    return stored;

}

/** True when the stored file can be read back. */
async function existsStored(relDir, filename, { access = 'public' } = {}) {
    if (!USE_BLOB) return fs.existsSync(path.join(PROJECT_ROOT, relDir, path.basename(filename)));
    try {
        const info = await store.head(blobKey(relDir, filename));
        return info !== null;
    } catch {
        return false;
    }
}

/** Read a stored file into a Buffer. Returns null when it does not exist. */
async function readStored(relDir, filename, { access = 'public' } = {}) {
    if (!USE_BLOB) {
        const abs = path.join(PROJECT_ROOT, relDir, path.basename(filename));
        return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
    }
    try {
        const obj = await store.getBuffer(blobKey(relDir, filename));
        return obj ? obj.buffer : null;
    } catch {
        return null;
    }
}

/**
 * Stream a stored file to the client. Falls back to the copy bundled with the
 * deployment (files that existed before the Blob switch) before giving up.
 * Returns true when something was sent.
 */
async function serveStored(res, relDir, filename, { access = 'public' } = {}) {
    const safeName = path.basename(filename);
    const bundled = path.join(PROJECT_ROOT, relDir, safeName);

    if (!USE_BLOB) {
        if (!fs.existsSync(bundled)) return false;
        res.sendFile(bundled);
        return true;
    }

    try {
        const obj = await store.getStream(blobKey(relDir, safeName));
        if (obj && obj.stream) {
            if (obj.contentType) res.setHeader('Content-Type', obj.contentType);
            if (obj.size) res.setHeader('Content-Length', obj.size);
            // If the client goes away mid-download, stop pulling from the store.
            res.on('close', () => obj.stream.destroy());
            obj.stream.on('error', (streamErr) => {
                console.warn('[fileStorage] object-store stream error for', blobKey(relDir, safeName), streamErr?.message || streamErr);
                if (!res.headersSent) res.status(502);
                res.end();
            });
            obj.stream.pipe(res);
            return true;
        }
    } catch (err) {
        console.warn('[fileStorage] object-store read failed for', blobKey(relDir, safeName), err?.message || err);
    }

    // Pre-existing files shipped inside the deployment bundle.
    if (fs.existsSync(bundled)) {
        res.sendFile(bundled);
        return true;
    }
    return false;
}

/** Best-effort delete. Never throws — callers treat cleanup as non-critical. */
async function deleteStored(relDir, filename, { access = 'public' } = {}) {
    const safeName = path.basename(filename);
    if (!USE_BLOB) {
        const abs = path.join(PROJECT_ROOT, relDir, safeName);
        try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignore */ }
        return;
    }
    try {
        await store.del(blobKey(relDir, safeName));
    } catch { /* ignore */ }
}

/**
 * Express handler that serves an upload folder over HTTP.
 * Mount it AFTER the matching express.static() so bundled files win and only
 * misses fall through to Blob.
 */
function staticFallback(relDir, { access = 'public' } = {}) {
    return async function serveUpload(req, res, next) {
        if (!USE_BLOB) return next();
        // req.path here is relative to the mount point, e.g. '/profiles/x.jpg'.
        const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
        if (!rel || rel.includes('..')) return next();
        const dir = path.posix.dirname(rel);
        const name = path.posix.basename(rel);
        const folder = dir === '.' ? relDir : `${relDir}/${dir}`;
        const sent = await serveStored(res, folder, name, { access });
        if (!sent) next();
    };
}

module.exports = {
    USE_BLOB,
    PROJECT_ROOT,
    localDir,
    makeStorage,
    finalizeUploads,
    storeFile,
    existsStored,
    readStored,
    serveStored,
    deleteStored,
    staticFallback,
};
