// Serverless safety timeout (server.js uses it on Vercel).
//
// Ensures every request sends *some* response before Vercel's 10 s (hobby) /
// 60 s (pro) hard timeout kills the function: after `ms` it answers 504.
//
// The route is still running at that point. Whatever it sends when it ends
// must not throw ERR_HTTP_HEADERS_SENT: in an async handler that becomes an
// unhandled rejection, which exits the process (server.js) and fails every
// other request on the same instance. So once the 504 is out, the response's
// write methods become no-ops.
const LATE_WRITE_METHODS = [
  'status', 'set', 'header', 'setHeader', 'type', 'json', 'send', 'sendFile',
  'sendStatus', 'redirect', 'cookie', 'writeHead', 'write', 'end',
];

function safetyTimeout(ms) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      console.error(`[TIMEOUT] Request timed out: ${req.method} ${req.originalUrl}`);
      res.status(504).json({ error: 'Request timed out' });
      const ignore = () => res;
      for (const method of LATE_WRITE_METHODS) res[method] = ignore;
    }, ms);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
}

module.exports = { safetyTimeout };
