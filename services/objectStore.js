// services/objectStore.js
// Purpose:
// - Give services/fileStorage.js an S3-compatible object-storage backend it can
//   use on ANY host (Render, Fly, a VPS, …), not just Vercel.
// - The concrete target is Cloudflare R2, reached over its S3-compatible API.
//
// Why a hand-rolled client instead of @aws-sdk/client-s3:
// - Zero new dependencies. Render Free has a small build; the AWS SDK pulls in
//   dozens of transitive packages for four one-shot requests.
// - Works offline and in unit tests: point R2_ENDPOINT at a local mock server
//   and every code path here is exercised with no real credentials.
// - Only four operations are needed (PUT / HEAD / GET / DELETE a single object),
//   all of which are a plain SigV4-signed HTTPS request.
//
// This module NEVER makes a network call at require() time and NEVER throws on
// require(). isConfigured() is a pure env check; client() returns the operation
// functions; a call only fails if the request itself fails.

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const REQUEST_TIMEOUT_MS = 30_000;

// ── Configuration ──────────────────────────────────────────────────────────
// R2_ENDPOINT     full S3 API endpoint, e.g. https://<accountid>.r2.cloudflarestorage.com
//                 (no bucket in the path). If unset, it is derived from R2_ACCOUNT_ID.
// R2_ACCOUNT_ID   Cloudflare account id — only used to build the endpoint when
//                 R2_ENDPOINT is not given.
// R2_BUCKET       bucket name (kept private; files are streamed back through Express).
// R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   R2 API token credentials.
// R2_REGION       SigV4 region label. R2 accepts "auto" (default).
function cfg() {
    const accountId = (process.env.R2_ACCOUNT_ID || '').trim();
    let endpoint = (process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
    if (!endpoint && accountId) {
        endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    }
    return {
        endpoint,
        bucket: (process.env.R2_BUCKET || '').trim(),
        accessKeyId: (process.env.R2_ACCESS_KEY_ID || '').trim(),
        secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY || '').trim(),
        region: (process.env.R2_REGION || 'auto').trim() || 'auto',
    };
}

/** True when every value needed to talk to R2 is present. Pure env check. */
function isConfigured() {
    const c = cfg();
    return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
}

/**
 * A short, non-sensitive description of what is missing / where we point.
 * Safe to log — contains no secret material.
 */
function describe() {
    const c = cfg();
    const missing = [];
    if (!c.endpoint) missing.push('R2_ENDPOINT or R2_ACCOUNT_ID');
    if (!c.bucket) missing.push('R2_BUCKET');
    if (!c.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
    if (!c.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
    if (missing.length) return `Cloudflare R2 not fully configured — missing: ${missing.join(', ')}`;
    return `Cloudflare R2 configured — bucket "${c.bucket}" via ${c.endpoint} (region ${c.region})`;
}

// ── AWS SigV4 (S3 flavour) ─────────────────────────────────────────────────

/** RFC 3986 percent-encoding. When encodeSlash is false, "/" is left intact. */
function uriEncode(str, encodeSlash) {
    let out = '';
    for (const ch of Buffer.from(String(str), 'utf8')) {
        const c = String.fromCharCode(ch);
        if (
            (ch >= 0x41 && ch <= 0x5a) || // A-Z
            (ch >= 0x61 && ch <= 0x7a) || // a-z
            (ch >= 0x30 && ch <= 0x39) || // 0-9
            c === '-' || c === '_' || c === '.' || c === '~'
        ) {
            out += c;
        } else if (c === '/') {
            out += encodeSlash ? '%2F' : '/';
        } else {
            out += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return out;
}

function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Build a signed request for one object operation.
 * @param {string} method  GET | HEAD | PUT | DELETE
 * @param {string} key     object key, e.g. "uploads/profiles/x.jpg"
 * @param {Buffer|null} body  request body (PUT only)
 * @param {string|undefined} contentType  Content-Type for PUT
 */
function signRequest(method, key, body, contentType) {
    const c = cfg();
    const endpointUrl = new URL(c.endpoint);
    const host = endpointUrl.host;

    // Path-style addressing: /<bucket>/<key>. Slashes inside the key stay literal.
    const canonicalPath = '/' + uriEncode(c.bucket, false) + '/' + uriEncode(key, false);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body && body.length ? sha256Hex(body) : EMPTY_SHA256;

    // Signed headers. content-type is only sent/signed on PUT.
    const headers = {
        host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
    };
    if (method === 'PUT' && contentType) headers['content-type'] = contentType;

    const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const canonicalHeaders = signedHeaderNames
        .map((h) => `${h}:${String(headers[h]).trim()}\n`)
        .join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
        method,
        canonicalPath,
        '', // canonical query string — always empty for these ops
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        scope,
        sha256Hex(Buffer.from(canonicalRequest, 'utf8')),
    ].join('\n');

    const kDate = hmac('AWS4' + c.secretAccessKey, dateStamp);
    const kRegion = hmac(kDate, c.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    headers['Authorization'] =
        `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
        protocol: endpointUrl.protocol,
        hostname: endpointUrl.hostname,
        port: endpointUrl.port || (endpointUrl.protocol === 'http:' ? 80 : 443),
        path: canonicalPath,
        headers,
    };
}

/**
 * Perform one signed request.
 * - stream:false (default) — buffers the body; resolves { statusCode, headers, body:Buffer }.
 * - stream:true            — resolves as soon as the response headers arrive with
 *                            { statusCode, headers, stream } where `stream` is the
 *                            live response (a Node Readable). The caller must
 *                            consume or destroy it. Used to serve large files
 *                            (videos) without holding them in memory.
 */
function send(method, key, body, contentType, { stream = false } = {}) {
    const signed = signRequest(method, key, body, contentType);
    const transport = signed.protocol === 'http:' ? http : https;

    return new Promise((resolve, reject) => {
        const req = transport.request(
            {
                method,
                hostname: signed.hostname,
                port: signed.port,
                path: signed.path,
                headers: {
                    ...signed.headers,
                    ...(body && body.length ? { 'Content-Length': body.length } : {}),
                },
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                if (stream) {
                    resolve({ statusCode: res.statusCode, headers: res.headers, stream: res });
                    return;
                }
                const chunks = [];
                res.on('data', (d) => chunks.push(d));
                res.on('end', () =>
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        );
        req.on('timeout', () => req.destroy(new Error(`R2 ${method} ${key} timed out after ${REQUEST_TIMEOUT_MS}ms`)));
        req.on('error', reject);
        if (body && body.length) req.write(body);
        req.end();
    });
}

/** Trim an S3 XML error body to something safe and short for a log line. */
function shortError(buf) {
    const text = buf ? buf.toString('utf8') : '';
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1];
    if (code || msg) return [code, msg].filter(Boolean).join(': ');
    return text.slice(0, 200);
}

// ── Public operations ─────────────────────────────────────────────────────

function client() {
    return {
        /** Upload (overwrites). Resolves { url } — a proxied relative path. */
        async put(key, buffer, contentType) {
            const res = await send('PUT', key, buffer, contentType || 'application/octet-stream');
            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`R2 PUT ${key} failed (HTTP ${res.statusCode}): ${shortError(res.body)}`);
            }
            // R2 bucket is private; the app always streams files back through
            // Express, so a relative proxied path is the only "URL" that matters.
            return { url: `/${key}` };
        },

        /** HEAD. Resolves { size, contentType } or null when the object is absent. */
        async head(key) {
            const res = await send('HEAD', key, null);
            if (res.statusCode === 404 || res.statusCode === 403) return null;
            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`R2 HEAD ${key} failed (HTTP ${res.statusCode})`);
            }
            return {
                size: Number(res.headers['content-length']) || 0,
                contentType: res.headers['content-type'] || null,
            };
        },

        /** GET (buffered). Resolves { buffer, contentType, size } or null when absent. */
        async getBuffer(key) {
            const res = await send('GET', key, null);
            if (res.statusCode === 404 || res.statusCode === 403) return null;
            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`R2 GET ${key} failed (HTTP ${res.statusCode}): ${shortError(res.body)}`);
            }
            return {
                buffer: res.body,
                contentType: res.headers['content-type'] || null,
                size: res.body.length,
            };
        },

        /**
         * GET (streaming). Resolves { stream, contentType, size } or null when
         * absent. `stream` is a live Node Readable — pipe it straight to the
         * HTTP response so large files never sit in memory.
         */
        async getStream(key) {
            const res = await send('GET', key, null, undefined, { stream: true });
            if (res.statusCode === 404 || res.statusCode === 403) {
                res.stream.resume(); // drain and discard
                return null;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.stream.resume();
                throw new Error(`R2 GET ${key} failed (HTTP ${res.statusCode})`);
            }
            return {
                stream: res.stream,
                contentType: res.headers['content-type'] || null,
                size: Number(res.headers['content-length']) || null,
            };
        },

        /** DELETE. Best effort — a missing object is not an error. */
        async del(key) {
            const res = await send('DELETE', key, null);
            if (res.statusCode >= 200 && res.statusCode < 300) return;
            if (res.statusCode === 404) return;
            throw new Error(`R2 DELETE ${key} failed (HTTP ${res.statusCode}): ${shortError(res.body)}`);
        },
    };
}

module.exports = { isConfigured, describe, client };
