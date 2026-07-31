// Tests for tools/preflight.js — the version verdict build.bat acts on.
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};
const truthy = (name, v) => ok(name, !!v, true);

const { decide } = require('../tools/preflight');

console.log('preflight.decide — exit codes drive the script:');
{
  ok('behind the latest release warns', decide('0.3.1', '0.3.2').code, 2);
  ok('level with the latest release is fine', decide('0.3.2', '0.3.2').code, 0);
  ok('ahead of the latest release is fine', decide('0.4.0', '0.3.2').code, 0);
  ok('no releases yet is fine', decide('0.3.2', null).code, 0);
  ok('a v-prefixed tag compares correctly', decide('0.3.2', 'v0.3.3').code, 2);
  ok('and the other way round', decide('0.4.0', 'v0.3.9').code, 0);
}

console.log('\npreflight.decide — the message says what to do:');
{
  const behind = decide('0.3.1', '0.3.2');
  truthy('behind names both versions',
    behind.headline.indexOf('0.3.1') >= 0 && behind.headline.indexOf('0.3.2') >= 0);
  truthy('behind tells you to pull', behind.detail.indexOf('git pull') >= 0);

  const level = decide('0.3.2', '0.3.2');
  truthy('level suggests bumping before publishing', level.detail.indexOf('npm version') >= 0);

  const ahead = decide('0.4.0', '0.3.2');
  truthy('ahead says it is expected', ahead.headline.indexOf('AHEAD') >= 0);

  const none = decide('0.3.2', null);
  truthy('no releases explains itself', none.headline.toLowerCase().indexOf('no releases') >= 0);
}

console.log('\npreflight.decide — never throws on odd input:');
{
  ok('empty latest treated as no release', decide('0.3.2', '').code, 0);
  ok('undefined latest treated as no release', decide('0.3.2', undefined).code, 0);
  ok('garbage latest does not warn', decide('0.3.2', 'banana').code, 0);
  truthy('garbage current still returns a verdict', typeof decide('nonsense', '1.0.0').code === 'number');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
