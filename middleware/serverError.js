// Unexpected-error reply for route handlers: the real error (database or
// driver message, stack) goes to the server log, and the page gets a plain
// message. Handlers used to send err.message straight to the browser.
function sendServerError(req, res, err, message = 'Something went wrong on the server. Please try again.') {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (!res.headersSent) res.status(500).json({ error: message });
}

module.exports = { sendServerError };
