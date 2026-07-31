// repo.js — work out which GitHub repository this build updates from.
//
// This cannot rely on package.json's `build` block: electron-builder strips
// that field out of the package.json it puts inside the packaged app, so a
// lookup that works in development returns nothing once installed. Three
// sources are tried in order, ending at a constant compiled into the app.

// Baked in, so it survives packaging no matter what else is stripped.
const FALLBACK = { owner: 'drakontosc9', repo: 'synapseMAIN' };

/** Pull owner/repo out of any of the URL shapes npm allows. */
function fromUrl(url) {
  const s = String(url || '');
  const m = s.match(/github\.com[:/]+([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  // "github:owner/repo" shorthand
  const short = s.match(/^github:([^/]+)\/([^/#?]+?)(?:\.git)?$/i);
  if (short) return { owner: short[1], repo: short[2] };
  return null;
}

/**
 * @param {object} pkg  the app's package.json
 * @returns {{owner:string, repo:string, source:string}}
 */
function resolveRepo(pkg) {
  const p = pkg || {};

  // 1. electron-builder publish config — present in development only
  const pub = (p.build && Array.isArray(p.build.publish) && p.build.publish[0]) || null;
  if (pub && pub.provider === 'github' && pub.owner && pub.repo) {
    return { owner: pub.owner, repo: pub.repo, source: 'build.publish' };
  }

  // 2. the standard npm `repository` field, which packaging keeps
  const r = p.repository;
  const hit = fromUrl(typeof r === 'string' ? r : (r && r.url));
  if (hit) return { owner: hit.owner, repo: hit.repo, source: 'repository' };

  // 3. compiled-in constant
  return { owner: FALLBACK.owner, repo: FALLBACK.repo, source: 'fallback' };
}

module.exports = { resolveRepo, fromUrl, FALLBACK };
