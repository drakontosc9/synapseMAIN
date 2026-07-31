// Tests for tree.js — planning a folder-tree import.
// The fixture is the directory shape from the feature request.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};
const truthy = (name, v) => ok(name, !!v, true);

const tree = require('../tree');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  const put = (rel, body) => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body == null ? 'contents of ' + path.basename(rel) : body);
  };
  // the shape from the request
  put('lab2a/empire/characters/vader.txt');
  put('lab2a/empire/characters/emperor.txt');
  put('lab2a/empire/characters/bobafett.txt');
  put('lab2a/empire/vehicles/atat.txt');
  put('lab2a/empire/vehicles/at-st.txt');
  put('lab2a/planets/hoth.txt');
  put('lab2a/planets/endor.txt');
  put('lab2a/rebellion/characters/luke.txt');
  put('lab2a/rebellion/characters/leia.txt');
  put('lab2a/rebellion/droids/r2.txt');
  put('lab2a/rebellion/droids/c3p0.txt');
  put('lab10/find1.txt');
  put('lab10/grep1.txt');
  put('git-practice/morgoth.txt');
  // things that must be left alone
  put('node_modules/junk/index.js', 'skip me');
  put('.git/config', 'skip me');
  put('.hidden.txt', 'skip me');
  put('notes/diagram.png', 'binary-ish');
  fs.mkdirSync(path.join(root, 'gxhi-3zig'), { recursive: true });   // empty folder
  return root;
}

console.log('tree.planTreeSync — mirrors the directory shape:');
{
  const root = makeFixture();
  const plan = tree.planTreeSync(root);

  truthy('finds the nested folders', plan.folders.indexOf('lab2a/empire/characters') >= 0);
  truthy('finds every level', plan.folders.indexOf('lab2a/rebellion/droids') >= 0);
  truthy('keeps empty folders (they become bubbles)', plan.folders.indexOf('gxhi-3zig') >= 0);
  ok('folder paths are posix', plan.folders.every(f => f.indexOf('\\') === -1), true);

  const rels = plan.files.map(f => f.rel);
  truthy('finds a leaf file', rels.indexOf('lab2a/empire/characters/vader.txt') >= 0);
  truthy('finds files at other depths', rels.indexOf('lab10/find1.txt') >= 0);
  ok('text files are classified as text',
    plan.files.find(f => f.rel === 'lab10/find1.txt').kind, 'text');
  ok('images are classified as binary',
    plan.files.find(f => f.rel === 'notes/diagram.png').kind, 'binary');

  truthy('skips node_modules', !plan.folders.some(f => f.indexOf('node_modules') >= 0));
  truthy('skips dotfolders', !plan.folders.some(f => f.indexOf('.git') >= 0));
  truthy('skips hidden files', !rels.some(r => r.indexOf('.hidden') >= 0));
  truthy('reports why it skipped', plan.skipped.some(s => /build\/system/.test(s.why)));

  ok('root name comes from the folder', plan.name, path.basename(root));
  truthy('total size counted', plan.bytes > 0);
  ok('nothing truncated at this size', plan.truncated, false);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\ntree.planTreeSync — limits:');
{
  const root = makeFixture();

  const capped = tree.planTreeSync(root, { maxFiles: 5 });
  ok('stops at maxFiles', capped.files.length, 5);
  ok('and says it truncated', capped.truncated, true);

  const shallow = tree.planTreeSync(root, { maxDepth: 1 });
  truthy('depth limit keeps the shallow folders', shallow.folders.indexOf('lab2a') >= 0);
  truthy('depth limit drops the deep ones',
    !shallow.files.some(f => f.rel === 'lab2a/empire/characters/vader.txt'));

  const textOnly = tree.planTreeSync(root, { includeBinaries: false });
  ok('text-only mode excludes images', textOnly.files.some(f => f.kind === 'binary'), false);
  truthy('and says why', textOnly.skipped.some(s => /not text/.test(s.why)));

  const withHidden = tree.planTreeSync(root, { includeHidden: true });
  truthy('hidden files can be opted in',
    withHidden.files.some(f => f.rel.indexOf('.hidden') >= 0));

  const tiny = tree.planTreeSync(root, { maxBytes: 1 });
  ok('byte ceiling truncates', tiny.truncated, true);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\ntree.describePlan:');
{
  const root = makeFixture();
  const d = tree.describePlan(tree.planTreeSync(root));
  truthy('counts folders', d.folders > 5);
  truthy('counts files', d.files > 10);
  ok('splits readable from attached', d.textFiles + d.otherFiles, d.files);
  truthy('formats a size', /KB|MB/.test(d.size));
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('\ntree.planTree (async) matches the sync walk:');
{
  const root = makeFixture();
  (async () => {
    const a = await tree.planTree(root);
    const b = tree.planTreeSync(root);
    ok('same folder count', a.folders.length, b.folders.length);
    ok('same file count', a.files.length, b.files.length);
    ok('same byte total', a.bytes, b.bytes);
    fs.rmSync(root, { recursive: true, force: true });

    console.log('\nunreadable roots do not throw:');
    const missing = await tree.planTree(path.join(os.tmpdir(), 'definitely-not-here-' + Date.now()));
    ok('empty plan for a missing folder', missing.files.length, 0);
    truthy('and it is reported', missing.skipped.length > 0);

    console.log('\n' + pass + ' passed, ' + fail + ' failed.');
    process.exit(fail ? 1 : 0);
  })();
}
