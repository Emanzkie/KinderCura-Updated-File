// Gives a vm page sandbox the real apiFetch from /api.js, the way a page gets it.
// The sandbox's own fetch stub still answers the requests.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'api.js'), 'utf8');
const apiFetchSrc = src.slice(src.indexOf('async function apiFetch('), src.indexOf('function requireAuth('));

module.exports = function loadApiFetch(sandbox) {
  if (!('API' in sandbox)) sandbox.API = '/api';
  if (!sandbox.KC) sandbox.KC = {};
  if (!sandbox.KC.token) sandbox.KC.token = () => null;
  vm.runInContext(apiFetchSrc, sandbox);
};
