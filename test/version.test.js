// Tests for version.js — the comparison the update check depends on.
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};

const { compare, isNewer, clean } = require('../version');

console.log('version.clean:');
{
  ok('strips a leading v', clean('v0.3.2'), '0.3.2');
  ok('strips a capital V', clean('V1.0.0'), '1.0.0');
  ok('leaves a bare version', clean('0.3.2'), '0.3.2');
  ok('drops build metadata', clean('1.2.3+build7'), '1.2.3');
  ok('trims whitespace', clean('  v2.0.0 '), '2.0.0');
  ok('handles null', clean(null), '');
}

console.log('\nversion.compare:');
{
  ok('equal versions', compare('1.2.3', '1.2.3'), 0);
  ok('patch newer', compare('1.2.4', '1.2.3'), 1);
  ok('patch older', compare('1.2.3', '1.2.4'), -1);
  ok('minor beats patch', compare('1.3.0', '1.2.9'), 1);
  ok('major beats minor', compare('2.0.0', '1.9.9'), 1);
  ok('v prefix is irrelevant', compare('v1.2.4', '1.2.3'), 1);
  ok('10 sorts above 9 numerically', compare('1.10.0', '1.9.0'), 1);
  ok('0.3.10 above 0.3.9', compare('0.3.10', '0.3.9'), 1);
  ok('missing patch treated as 0', compare('1.2', '1.2.0'), 0);
  ok('release beats its prerelease', compare('1.0.0', '1.0.0-beta'), 1);
  ok('prerelease loses to release', compare('1.0.0-beta', '1.0.0'), -1);
  ok('prereleases compare textually', compare('1.0.0-beta2', '1.0.0-beta1'), 1);
  // unparseable input must never sort as newer — an update is offered only on
  // a version we could actually read
  ok('garbage is never above a real version', compare('not-a-version', '0.0.0') <= 0, true);
  ok('garbage is never above a release', compare('banana', '1.2.3') < 0, true);
}

console.log('\nversion.isNewer (the actual question the updater asks):');
{
  ok('a newer release is offered', isNewer('0.3.3', '0.3.2'), true);
  ok('the same version is not', isNewer('0.3.2', '0.3.2'), false);
  ok('an older release is not', isNewer('0.3.1', '0.3.2'), false);
  ok('tagged release vs running build', isNewer('v0.4.0', '0.3.2'), true);
  ok('a prerelease of the same version is not newer', isNewer('0.3.2-rc1', '0.3.2'), false);
  ok('empty tag never triggers an update', isNewer('', '0.3.2'), false);
  ok('null tag never triggers an update', isNewer(null, '0.3.2'), false);
  ok('garbage tag never triggers an update', isNewer('banana', '0.3.2'), false);
  ok('undefined tag never triggers an update', isNewer(undefined, '0.3.2'), false);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
