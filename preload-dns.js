const dns = require('dns');
// Use public DNS for SRV resolution in local dev when system resolver blocks SRV
dns.setServers(['8.8.8.8', '1.1.1.1']);
console.log('preload-dns: overridden DNS servers ->', dns.getServers());
