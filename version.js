// version.js — tiny semver comparison, no dependencies.
// Only what an updater needs: is the release on GitHub newer than what is
// running? Build metadata is ignored; a prerelease loses to the same release.

/** Strip a leading "v" and any build metadata. */
function clean(v) {
  return String(v == null ? '' : v).trim().replace(/^[vV]/, '').split('+')[0];
}

function parts(v) {
  const c = clean(v);
  const dash = c.indexOf('-');
  const core = dash === -1 ? c : c.slice(0, dash);
  const pre = dash === -1 ? '' : c.slice(dash + 1);
  const nums = core.split('.').map(n => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  return { nums, pre };
}

/**
 * -1 if a < b, 0 if equal, 1 if a > b.
 * Unparseable input sorts as 0.0.0 rather than throwing.
 */
function compare(a, b) {
  const pa = parts(a), pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i] || 0, y = pb.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;          // 1.0.0 beats 1.0.0-beta
  if (!pb.pre) return -1;
  return pa.pre > pb.pre ? 1 : -1;
}

/** Is `candidate` a newer release than `current`? */
function isNewer(candidate, current) { return compare(candidate, current) > 0; }

module.exports = { compare, isNewer, clean };
