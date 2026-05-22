const { MongoClient } = require('mongodb');

module.exports = async (req, res) => {
  let client;
  
  try {
    // Check MongoDB connection
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
        mongodbPresent = false;
      }
    }

    res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      mongodb_present: mongodbPresent,
      vercel: process.env.VERCEL === '1',
      vercel_env: process.env.VERCEL_ENV || 'development',
      node_env: process.env.NODE_ENV || 'development'
    });
    
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
};