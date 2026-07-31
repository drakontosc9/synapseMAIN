// tools/preflight.js — run before a local build.
//
// Answers one question: is what you are about to build actually current?
// Compares this checkout's version against the newest GitHub Release and
// reports plainly. Exit code tells build.bat what to do.
//
//   0  fine to build (up to date, or ahead of the last release)
//   2  this checkout is BEHIND the latest release — probably wants a git pull
//   3  could not check (offline, rate limited); building is still fine
//
// Run directly:  node tools/preflight.js

const https = require('https');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const { resolveRepo } = require(path.join(ROOT, 'repo'));
const { compare, clean } = require(path.join(ROOT, 'version'));

/**
 * Pure decision step, so the interesting part is testable without a network.
 * @returns {{code:number, headline:string, detail:string}}
 */
function decide(current, latest) {
  if (!latest) {
    return {
      code: 0,
      headline: 'No releases published yet.',
      detail: 'Nothing to compare against - building ' + current + '.'
    };
  }
  const cmp = compare(clean(current), clean(latest));
  if (cmp > 0) {
    return {
      code: 0,
      headline: 'This checkout (' + current + ') is AHEAD of the latest release (' + latest + ').',
      detail: 'You are building something new. That is expected when preparing a release.'
    };
  }
  if (cmp === 0) {
    return {
      code: 0,
      headline: 'Up to date - version ' + current + ' matches the latest release.',
      detail: 'Rebuilding the same version. Bump it with "npm version patch" before publishing.'
    };
  }
  return {
    code: 2,
    headline: 'This checkout (' + current + ') is BEHIND the latest release (' + latest + ').',
    detail: 'You are about to build an older version than what is published. Run "git pull" first.'
  };
}

function fetchLatest(owner, repo) {
  const url = 'https://api.github.com/repos/' + owner + '/' + repo + '/releases/latest';
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Synapse-Preflight', 'Accept': 'application/vnd.github+json' },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);          // no releases yet
        if (res.statusCode === 403) return reject(new Error('GitHub rate limit reached'));
        if (res.statusCode !== 200) return reject(new Error('GitHub returned ' + res.statusCode));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('unreadable response from GitHub')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out contacting GitHub')));
    req.on('error', reject);
  });
}

async function main() {
  const where = resolveRepo(pkg);
  const current = pkg.version;

  console.log('  building : Synapse ' + current);
  console.log('  checking : github.com/' + where.owner + '/' + where.repo);

  let rel;
  try {
    rel = await fetchLatest(where.owner, where.repo);
  } catch (err) {
    console.log('');
    console.log('  Could not reach GitHub (' + err.message + ').');
    console.log('  Skipping the version check - the build itself does not need a network.');
    process.exit(3);
  }

  const latest = rel ? clean(rel.tag_name || rel.name || '') : null;
  const verdict = decide(current, latest);
  console.log('');
  console.log('  ' + verdict.headline);
  console.log('  ' + verdict.detail);
  if (rel && rel.html_url) console.log('  ' + rel.html_url);
  process.exit(verdict.code);
}

module.exports = { decide };

if (require.main === module) {
  main().catch((err) => {
    console.log('  Preflight failed: ' + (err && err.message));
    process.exit(3);
  });
}
