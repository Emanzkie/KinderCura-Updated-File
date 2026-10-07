// tests/unit/ml-service-client.test.js
// How the Node server reports ML_SERVICE_URL problems. The production Retrain
// error was `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`: the
// health check got an HTML page with HTTP 2xx (fetch had followed a redirect)
// and parsed it as JSON. These cases use local stand-in servers, no Python.

const assert = require('assert');
const http = require('http');

process.env.ML_SERVICE_SECRET = 'test-ml-secret';
process.env.APP_URL = 'https://kindercura.com';
delete process.env.USE_LOCAL_PYTHON;
delete process.env.VERCEL;
delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

const modelManager = require('../../ml/model_manager');

function serve(handler) {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close(),
  })));
}

const LOGIN_PAGE = '<!DOCTYPE html><html><head><title>Login – Vercel</title></head><body>Log in to Vercel</body></html>';

async function healthWith(url) {
  process.env.ML_SERVICE_URL = url;
  return modelManager.checkPythonEnvironment();
}

async function run() {
  // 1. A site that answers every path with an HTML page and HTTP 200.
  const site = await serve((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!DOCTYPE html><html><head><title>KinderCura</title></head></html>'); });
  let r = await healthWith(site.url);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /returned HTTP 200 with content-type text\/html; charset=utf-8 instead of JSON/);
  assert.match(r.error, /serving a web page, not the KinderCura Python ML functions/);
  assert.doesNotMatch(r.error, /Unexpected token/);
  site.close();

  // 2. Vercel Deployment Protection: redirect to the Vercel login. The redirect
  //    must not be followed (following it is what produced the 200 HTML).
  const login = await serve((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(LOGIN_PAGE); });
  const protectedSite = await serve((req, res) => { res.statusCode = 307; res.setHeader('Location', `https://vercel.com/sso-api?url=x&next=${login.url}`); res.end(); });
  r = await healthWith(protectedSite.url);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /redirected \(HTTP 307\) to vercel\.com/);
  assert.match(r.error, /Vercel Deployment Protection/);
  assert.match(r.error, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.strictEqual(login.seen.length, 0, 'redirects must not be followed');
  protectedSite.close();

  // 3. Protection answering 401 with its HTML page.
  const protected401 = await serve((req, res) => { res.statusCode = 401; res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Authentication Required</title><a href="https://vercel.com/sso-api">Vercel</a>'); });
  r = await healthWith(protected401.url);
  assert.match(r.error, /HTTP 401 .*instead of JSON .*Authentication Required.*Vercel Deployment Protection/);
  protected401.close();
  login.close();

  // 4. The bypass header is sent when configured, and never appears in errors.
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'bypass-value';
  const ml = await serve((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, service: 'kindercura-ml-train', status: 'ready', secretConfigured: true, authorized: req.headers['x-ml-secret'] === 'test-ml-secret' }));
  });
  r = await healthWith(`${ml.url}/api/py/train/`); // 5. path accidentally included
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.secretVerified, true);
  assert.strictEqual(ml.seen[0].url, '/api/py/train', 'must not request /api/py/train/api/py/train');
  assert.strictEqual(ml.seen[0].headers['x-vercel-protection-bypass'], 'bypass-value');
  assert.strictEqual(ml.seen[0].headers['x-ml-secret'], 'test-ml-secret');
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  // 6. Secret mismatch is reported without revealing either value.
  process.env.ML_SERVICE_SECRET = 'other-secret';
  r = await healthWith(ml.url);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /does not match/);
  assert.doesNotMatch(r.error, /other-secret|test-ml-secret/);
  process.env.ML_SERVICE_SECRET = 'test-ml-secret';

  // 6b. The production 401: Vercel answers a JSON Accept with a JSON error
  //     object before the function runs. It used to print "[object Object]".
  const vercelBlock = await serve((req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'Authentication Required' } }));
  });
  r = await healthWith(vercelBlock.url);
  assert.strictEqual(r.ok, false);
  assert.doesNotMatch(r.error, /\[object Object\]/);
  assert.match(r.error, /Vercel rejected GET .*\/api\/py\/train with HTTP 401 \(unauthorized: Authentication Required\) before it reached the KinderCura ML function/);
  assert.match(r.error, /Deployment Protection/);
  assert.match(r.error, /VERCEL_AUTOMATION_BYPASS_SECRET/);
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'wrong-bypass';
  r = await healthWith(vercelBlock.url);
  assert.match(r.error, /VERCEL_AUTOMATION_BYPASS_SECRET is set on this server, but Vercel did not accept it/);
  assert.doesNotMatch(r.error, /wrong-bypass/);
  delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  vercelBlock.close();

  // 6c. Our own function rejecting the secret on POST is reported as such.
  const fnReject = await serve((req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: false, error: 'Unauthorized: invalid or missing ML_SERVICE_SECRET' }));
  });
  process.env.ML_SERVICE_URL = fnReject.url;
  await assert.rejects(modelManager.mlServiceRequest('/api/py/train', { method: 'POST', body: '{}' }), (err) => {
    assert.strictEqual(err.code, 'ml_service_unauthorized');
    assert.match(err.message, /ML service authentication failed \(HTTP 401\).*Check that ML_SERVICE_SECRET is identical on Render and on Vercel/);
    return true;
  });
  fnReject.close();

  // 6d. Any other JSON error object is readable.
  const objErr = await serve((req, res) => { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: { code: 'FUNCTION_INVOCATION_FAILED', message: 'crashed' } })); });
  r = await healthWith(objErr.url);
  assert.match(r.error, /health check returned HTTP 500: FUNCTION_INVOCATION_FAILED: crashed/);
  objErr.close();

  // 7. JSON from something that is not the ML service.
  const other = await serve((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"error":"Not found: GET /api/py/train"}'); });
  r = await healthWith(other.url);
  assert.match(r.error, /HTTP 200|not as kindercura-ml-train/);
  other.close();
  ml.close();

  // 8. ML_SERVICE_URL pointing back at this Node app.
  r = await healthWith('https://kindercura.com');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /points at this Node app \(kindercura\.com\)/);

  // 9. Nothing listening.
  r = await healthWith('http://127.0.0.1:9');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /is unreachable/);

  console.log('ML service client tests OK — HTML/redirect/protection/self-URL/secret-mismatch/doubled-path diagnostics');
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
