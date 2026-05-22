// Temporary ping endpoint to verify environment variable visibility on Vercel
// - Does NOT import mongoose or perform any network I/O
// - Returns whether `MONGODB_URI` is present in the runtime env

module.exports = (req, res) => {
  const mongodbPresent = !!process.env.MONGODB_URI;
  const vercel = !!process.env.VERCEL;
  const vercelEnv = process.env.VERCEL_ENV || null;
  const nodeEnv = process.env.NODE_ENV || null;

  // Helpful log for deployment inspection (does not print secrets)
  console.log('[api/ping] mongodb_present=%s vercel=%s vercel_env=%s', mongodbPresent, vercel, vercelEnv);

  res.setHeader('Content-Type', 'application/json');
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    timestamp: new Date().toISOString(),
    mongodb_present: mongodbPresent,
    vercel,
    vercel_env: vercelEnv,
    node_env: nodeEnv,
  }));
};
