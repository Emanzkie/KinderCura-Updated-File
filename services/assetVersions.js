// Content versions for the app's own scripts and stylesheets.
//
// Pages are always revalidated by the browser, but CSS and JS may be reused
// from its cache for 10 minutes and then served stale for up to a day (see
// CACHE_RULES in server.js). After a deploy the browser could therefore run
// new HTML with an old script — PEDIA/pedia-reports.html's Section B stayed on
// "Loading…" that way. server.js sends every page through
// versionAssetUrls(), which appends ?v=<hash of the file's content> to each
// local .css/.js URL, so a changed file always gets a URL no cache has seen,
// with nothing to bump by hand. Vercel's CDN keys on the query string too.
//
// Line endings are normalised so a Windows checkout (CRLF) and the Linux
// deployment (LF) produce the same version.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// URL prefix -> folder, matching the static mounts in server.js. Any other
// path is served from the project root.
const MOUNTS = [
    ['/public/', 'public'],
    ['/css/', 'CSS files'],
    ['/assets/css/', 'CSS files'],
    ['/assets/js/', 'assets/js'],
    ['/js/', 'js'],
];

// The file a local asset URL is served from, or null if it is not a file.
function assetFile(urlPath) {
    let decoded;
    try {
        decoded = path.posix.normalize(decodeURIComponent(urlPath));
    } catch {
        return null;
    }
    const mount = MOUNTS.find(([prefix]) => decoded.startsWith(prefix));
    const file = mount
        ? path.join(ROOT, mount[1], decoded.slice(mount[0].length))
        : path.join(ROOT, decoded);
    try {
        return fs.statSync(file).isFile() ? file : null;
    } catch {
        return null;
    }
}

function contentVersion(text) {
    return crypto.createHash('sha1').update(text.split('\r\n').join('\n')).digest('hex').slice(0, 10);
}

// Keyed on mtime and size, so an edit during local development is picked up
// without a restart; on Vercel the files never change within a deployment.
const versions = new Map();
function assetVersion(file) {
    const { mtimeMs, size } = fs.statSync(file);
    const cached = versions.get(file);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.version;
    const version = contentVersion(fs.readFileSync(file, 'utf8'));
    versions.set(file, { mtimeMs, size, version });
    return version;
}

// Root-relative .css/.js URLs with no query string, in src="…" or href="…".
const LOCAL_ASSET = /\b(src|href)=(["'])(\/(?!\/)[^"'?#]*\.(?:css|js))\2/gi;

function versionAssetUrls(html) {
    return html.replace(LOCAL_ASSET, (match, attr, quote, url) => {
        const file = assetFile(url);
        return file ? `${attr}=${quote}${url}?v=${assetVersion(file)}${quote}` : match;
    });
}

module.exports = { assetFile, assetVersion, contentVersion, versionAssetUrls };
