// api/ping.js
const { MongoClient } = require('mongodb');

module.exports = async (req, res) => {
  // Set CORS headers (important for browser access)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  let client;
  
  try {
    const uri = process.env.MONGODB_URI;
    let mongodbPresent = false;
    
    if (uri) {
      try {
        client = new MongoClient(uri, {
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 3000,
        });
        
        await client.connect();
        await client.db().admin().ping();
        mongodbPresent = true;
      } catch (dbError) {
        // Log error but don't fail the whole request
        console.error('MongoDB connection error:', dbError.message);
        mongodbPresent = false;
      }
    }

    const responseData = {
      ok: true,
      timestamp: new Date().toISOString(),
      mongodb_present: mongodbPresent,
      vercel: process.env.VERCEL === '1',
      vercel_env: process.env.VERCEL_ENV || 'development',
      node_env: process.env.NODE_ENV || 'development'
    };

    // ✅ Use native Node.js response methods (NOT Express!)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseData));
    
  } catch (error) {
    console.error('Function error:', error.message);
    
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error.message
    }));
    
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
};