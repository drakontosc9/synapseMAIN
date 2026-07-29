// Tests for safeio.js — atomic writes and vault path containment.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};

const safeio = require('../safeio');

console.log('safeio.js atomic writes:');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safeio-'));
  const file = path.join(dir, 'note.md');

  safeio.writeFileAtomic(file, 'first');
  ok('writes a new file', fs.readFileSync(file, 'utf8'), 'first');

  safeio.writeFileAtomic(file, 'second');
  ok('overwrites in place', fs.readFileSync(file, 'utf8'), 'second');

  ok('leaves no temp files behind',
    fs.readdirSync(dir).filter(f => f.indexOf('.tmp') !== -1).length, 0);

  const nested = path.join(dir, 'a', 'b', 'deep.md');
  safeio.writeFileAtomic(nested, 'x');
  ok('creates missing parent dirs', fs.readFileSync(nested, 'utf8'), 'x');

  const jsonFile = path.join(dir, 'cfg.json');
  safeio.writeJsonAtomic(jsonFile, { a: 1 });
  ok('writeJsonAtomic round-trips', JSON.parse(fs.readFileSync(jsonFile, 'utf8')), { a: 1 });
}

console.log('\nsafeio.js vault containment:');
{
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultroot-'));
  const inside = p => {
    const r = safeio.resolveInVault(vaultDir, p);
    return r === null ? null : r.startsWith(path.resolve(vaultDir));
  };

  ok('plain note allowed', inside('Tasks/a.md'), true);
  ok('spaces in names allowed', inside('My Notes/a b.md'), true);
  ok('nested note allowed', inside('Ideas/Sub/x.md'), true);
  ok('parent escape refused', safeio.resolveInVault(vaultDir, '../outside.md'), null);
  ok('deep escape refused', safeio.resolveInVault(vaultDir, '../../../etc/passwd'), null);
  ok('backslash escape refused', safeio.resolveInVault(vaultDir, '..\\..\\Windows\\win.ini'), null);
  ok('absolute path refused', safeio.resolveInVault(vaultDir, path.resolve('/etc/hosts')), null);
  ok('empty id refused', safeio.resolveInVault(vaultDir, ''), null);
  ok('non-string refused', safeio.resolveInVault(vaultDir, null), null);
  ok('nul byte refused', safeio.resolveInVault(vaultDir, 'a' + String.fromCharCode(0) + '.md'), null);
  ok('no vault refused', safeio.resolveInVault(null, 'a.md'), null);
}

console.log('\nsafeio.js sanitizeName:');
{
  ok('keeps spaces', safeio.sanitizeName('My Group'), 'My Group');
  ok('keeps dashes', safeio.sanitizeName('half-baked'), 'half-baked');
  ok('strips path separators', safeio.sanitizeName('a/b:c'), 'abc');
  ok('strips illegal chars', safeio.sanitizeName('a*b?c"d<e>f|g'), 'abcdefg');
  ok('strips leading dots', safeio.sanitizeName('..hidden'), 'hidden');
  ok('strips trailing dot', safeio.sanitizeName('name.'), 'name');
  ok('falls back when empty', safeio.sanitizeName('///', 'New Group'), 'New Group');
  ok('falls back on null', safeio.sanitizeName(null, 'New Group'), 'New Group');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
