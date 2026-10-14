// scripts/backup.js
// Bookmarks the current GitHub `main` as a backup branch before a change, so
// the exact pre-change code can always be found and restored.
//
// Creates `backup/<YYYY-MM-DD>-<name>` on origin pointing at origin/main. It
// never touches your working copy or current branch, and it refuses to reuse
// an existing name, so a backup is never overwritten.
//
// Usage:
//   npm run backup -- before-cache
//   npm run backup -- before-cache --dry-run
//
// To restore later, see the backup branch on GitHub (Branches tab) and revert
// main to it with a normal commit — never a force-push.
const { execFileSync } = require('child_process');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function run() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const name = args.find((a) => !a.startsWith('--'));

  if (!name || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) {
    console.error('Usage: npm run backup -- <short-name>   (lowercase letters, numbers and dashes, e.g. before-cache)');
    process.exit(1);
  }

  const branch = `backup/${today()}-${name}`;

  git('fetch', '--quiet', 'origin', 'main');
  const sha = git('rev-parse', 'origin/main');
  const subject = git('log', '-1', '--format=%s', sha);

  if (git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)) {
    console.error(`Backup "${branch}" already exists on GitHub. Pick another name.`);
    process.exit(1);
  }

  console.log(`Backing up main ${sha.slice(0, 7)} ("${subject}")`);
  console.log(`  -> ${branch}`);
  if (dryRun) {
    console.log('Dry run: nothing pushed.');
    return;
  }

  git('push', '--quiet', 'origin', `${sha}:refs/heads/${branch}`);
  console.log('Done. It is listed on GitHub under Branches.');
}

try {
  run();
} catch (err) {
  console.error('Backup failed:', (err.stderr && String(err.stderr).trim()) || err.message);
  process.exit(1);
}
