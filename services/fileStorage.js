// services/fileStorage.js
// Purpose:
// - give every upload route one place to decide where a file physically lives
// - keep local development byte-for-byte identical to how it worked before
// - make uploads survive on Vercel, whose filesystem is read-only outside /tmp
//
// Locally, uploads keep going to the same folders under the project root and
// multer keeps using diskStorage, so nothing about the dev workflow changes.
// On Vercel, multer buffers the file in memory and this module pushes it to
// Vercel Blob under the *same* relative path (e.g. `uploads/profiles/x.jpg`).
// Because the stored path is unchanged, existing DB records and existing
// frontend <img src="/uploads/..."> URLs keep working with no migration.
//
// The blob store is private (see BLOB_ACCESS below), so no uploaded file is
// reachable by URL. Everything is read back through this module, and the
// routes apply their own auth checks first — PRC ID cards, e-wallet payment
// proofs and ML training datasets are only ever streamed to an admin. Profile
// photos and videos are served the same way, proxied through Express rather
// than fetched from a CDN.

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Readable } = require('stream');

const PROJECT_ROOT = path.join(__dirname, '..');

// Vercel Blob is used only when the app is actually running on Vercel *and* a
// token exists. Without the token we fall back to disk so a misconfigured
// deployment fails loudly at write time instead of silently losing files.
const ON_VERCEL = !!(process.env.VERCEL || process.env.NOW_REGION);
const HAS_BLOB_TOKEN = !!process.env.BLOB_READ_WRITE_TOKEN;
const USE_BLOB = ON_VERCEL && HAS_BLOB_TOKEN;

if (ON_VERCEL && !HAS_BLOB_TOKEN) {
    console.error(
        '[fileStorage] Running on Vercel without BLOB_READ_WRITE_TOKEN. ' +
        'Uploads will fail because the deployment filesystem is read-only. ' +
        'Add a Blob store to the project and redeploy.'
    );
}

// A Vercel Blob store has ONE access level covering every object inside it,
// so the per-call `access` hint the routes pass is a statement of intent, not
// something the SDK can vary per file. KinderCura's store is PRIVATE: PRC ID
// cards, e-wallet payment proofs and ML training data must never be reachable
// by URL, and the files that do get shown in the browser (profile photos,
// videos) are already proxied through Express by staticFallback below — so
// nothing in the app needs a directly public blob URL.
// Set BLOB_STORE_ACCESS=public only if the store is ever recreated as public.
const BLOB_ACCESS = process.env.BLOB_STORE_ACCESS === 'public' ? 'public' : 'private';

// `@vercel/blob` is only require()d when it will be used, so local development
// and local tests never need the package resolved at startup.
function blob() {
    // eslint-disable-next-line global-require
    return require('@vercel/blob');
}

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
            const { put } = blob();
            for (const file of files) {
                const name = await new Promise((resolve, reject) => {
                    filenameFn(req, file, (err, generated) => (err ? reject(err) : resolve(generated)));
                });
                const key = blobKey(relDir, name);
                const result = await put(key, file.buffer, {
                    access: BLOB_ACCESS,
                    contentType: file.mimetype,
                    addRandomSuffix: false,
                    allowOverwrite: true,
                });
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
        const { put } = blob();
        const result = await put(blobKey(relDir, safeName), file.buffer, {
            access: BLOB_ACCESS,
            contentType: file.mimetype,
            addRandomSuffix: false,
            allowOverwrite: true,
        });
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
        const { head } = blob();
        await head(blobKey(relDir, filename), { access: BLOB_ACCESS });
        return true;
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
        const { get } = blob();
        const result = await get(blobKey(relDir, filename), { access: BLOB_ACCESS });
        if (!result || !result.stream) return null;
        const chunks = [];
        for await (const chunk of Readable.fromWeb(result.stream)) chunks.push(chunk);
        return Buffer.concat(chunks);
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
        const { get } = blob();
        const result = await get(blobKey(relDir, safeName), { access: BLOB_ACCESS });
        if (result && result.stream) {
            if (result.blob?.contentType) res.setHeader('Content-Type', result.blob.contentType);
            if (result.blob?.size) res.setHeader('Content-Length', result.blob.size);
            Readable.fromWeb(result.stream).pipe(res);
            return true;
        }
    } catch (err) {
        console.warn('[fileStorage] blob read failed for', blobKey(relDir, safeName), err?.message || err);
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
        const { del } = blob();
        await del(blobKey(relDir, safeName), { access: BLOB_ACCESS });
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
