// api/index.js — Vercel serverless entry point
// Express app is exported directly. @vercel/node handles the wrapping.
require('dotenv').config();
const { connectDB, mongoose } = require('../db');
const app = require('../server');

// Start DB connection in background (does not block requests)
if (mongoose.connection.readyState === 0) {
  connectDB().catch(err => {
    console.error('[api/index] DB connect error:', err?.stack || err);
  });
}

// Export Express app directly — @vercel/node runtime supports this natively
module.exports = app;
