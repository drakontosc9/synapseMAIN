// Tests for the hierarchy rules: parents are always bigger, folders are
// linkable, folders act as parents, and nothing overlaps.
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

const vault = require('../vault');
const NL = '\n';

function write(dir, rel, lines) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join(NL));
}

// ---------------------------------------------------------------- vault model
console.log('folders are linkable through folder notes:');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hier-'));
  // Ideas/Ideas.md is the folder note for Ideas
  write(dir, 'Ideas/Ideas.md', ['---', 'title: "Ideas"', 'folder: Ideas', 'tags: [folder]', '---',
    'This folder relates to [[Research]].']);
  write(dir, 'Ideas/spark.md', ['---', 'title: "Spark"', 'folder: Ideas', 'tags: [x]', '---', 'a thought']);
  write(dir, 'Research/Research.md', ['---', 'title: "Research"', 'folder: Research', 'tags: [folder]', '---',
    'reading list']);
  write(dir, 'Research/paper.md', ['---', 'title: "Paper"', 'folder: Research', 'tags: [x]', '---',
    'cites [[Ideas]]']);

  vault.clearCache();
  const m = vault.scan(dir);
  const byId = new Map(m.nodes.map(n => [n.id, n]));

  ok('folder note is not a separate node', !!byId.get('Ideas/Ideas.md'), false);
  truthy('the folder itself is a node', byId.get('Ideas'));
  ok('folder carries its note file', byId.get('Ideas').noteFile, 'Ideas/Ideas.md');
  ok('folder inherits the note tags', byId.get('Ideas').tags, ['folder']);

  const wl = m.links.filter(l => l.type === 'wikilink');
  truthy('folder -> folder link exists',
    wl.some(l => (l.source === 'Ideas' && l.target === 'Research')));
  truthy('note -> folder link exists',
    wl.some(l => (l.source === 'Research/paper.md' && l.target === 'Ideas') ||
                 (l.target === 'Research/paper.md' && l.source === 'Ideas')));

  ok('folder note excluded from note count', byId.get('Ideas').noteCount, 1);
}

console.log('\nfolders act as parents:');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hier2-'));
  write(dir, 'Top/Sub/leaf.md', ['---', 'title: "Leaf"', 'folder: Sub', 'tags: []', '---', 'x']);
  write(dir, 'Top/mid.md', ['---', 'title: "Mid"', 'folder: Top', 'tags: []', '---', 'y']);
  write(dir, 'Top/child.md', ['---', 'title: "Child"', 'folder: Top', 'tags: []',
    'parent: "Top/mid.md"', '---', 'z']);

  vault.clearCache();
  const m = vault.scan(dir);
  const byId = new Map(m.nodes.map(n => [n.id, n]));

  ok('a note with no parent inherits its folder', byId.get('Top/Sub/leaf.md').effectiveParent, 'Top/Sub');
  ok('a sub-folder inherits its parent folder', byId.get('Top/Sub').effectiveParent, 'Top');
  ok('an explicit parent still wins', byId.get('Top/child.md').effectiveParent, 'Top/mid.md');
  ok('a top-level folder has no parent', byId.get('Top').effectiveParent, null);
}

// ---------------------------------------------------------------- graph rules
console.log('\nparents are always bigger:');
{
  global.window = { devicePixelRatio: 1, addEventListener() {} };
  global.requestAnimationFrame = () => 0;
  if (!global.performance) global.performance = { now: () => Date.now() };
  const canvas = {
    clientWidth: 900, clientHeight: 600, width: 900, height: 600, style: {},
    getContext: () => new Proxy({}, { get: () => () => {} }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }),
    addEventListener() {}
  };
  delete require.cache[require.resolve('../src/graph.js')];
  require('../src/graph.js');
  const SG = global.window.SynapseGraph;
  const g = new SG(canvas, {});

  // a deliberately fat note inside a small folder, plus a note-parent chain
  g.setData({
    folders: ['Small'],
    nodes: [
      { id: '__root__', type: 'root', title: 'Vault', containerId: null },
      { id: 'Small', type: 'folder', title: 'Small', containerId: '__root__', folder: 'Small', noteCount: 1 },
      { id: 'Small/Deep', type: 'folder', title: 'Deep', containerId: 'Small', folder: 'Deep', noteCount: 1 },
      // huge body + many links: without the rule this would outgrow its folder
      { id: 'Small/Deep/whale.md', type: 'note', title: 'Whale', containerId: 'Small/Deep', folder: 'Deep', tags: [], links: [], mass: 500000 },
      { id: 'Small/parent.md', type: 'note', title: 'P', containerId: 'Small', folder: 'Small', tags: [], links: [], mass: 1 },
      { id: 'Small/kid.md', type: 'note', title: 'K', containerId: 'Small', folder: 'Small', tags: [], links: [], mass: 40000, parentNote: 'Small/parent.md' }
    ],
    links: [],
    suggestions: []
  });

  const r = id => g.map.get(id).r;
  truthy('containing folder outgrows a fat note', r('Small/Deep') > r('Small/Deep/whale.md'));
  truthy('grandparent folder outgrows the sub-folder', r('Small') > r('Small/Deep'));
  truthy('growth propagates up the whole chain', r('Small') > r('Small/Deep/whale.md'));
  truthy('a parent note outgrows its heavier child', r('Small/parent.md') > r('Small/kid.md'));

  // the invariant must survive a config change that rescales everything
  g.setConfig({ nodeScale: 2 });
  truthy('invariant holds after rescaling', r('Small/Deep') > r('Small/Deep/whale.md'));
  truthy('note-parent invariant holds after rescaling', r('Small/parent.md') > r('Small/kid.md'));

  // and a cycle in the parent chain must not hang the sizer
  g.setData({
    folders: ['A'],
    nodes: [
      { id: '__root__', type: 'root', title: 'Vault', containerId: null },
      { id: 'A', type: 'folder', title: 'A', containerId: '__root__', folder: 'A', noteCount: 2 },
      { id: 'A/x.md', type: 'note', title: 'X', containerId: 'A', folder: 'A', tags: [], links: [], mass: 10, parentNote: 'A/y.md' },
      { id: 'A/y.md', type: 'note', title: 'Y', containerId: 'A', folder: 'A', tags: [], links: [], mass: 10, parentNote: 'A/x.md' }
    ],
    links: [], suggestions: []
  });
  truthy('a parent cycle does not hang sizing', g.map.get('A/x.md').r > 0);

  console.log('\ncollision keeps bubbles apart:');
  g.setData({
    folders: ['One', 'Two'],
    nodes: [
      { id: '__root__', type: 'root', title: 'Vault', containerId: null },
      { id: 'One', type: 'folder', title: 'One', containerId: '__root__', folder: 'One', noteCount: 3 },
      { id: 'Two', type: 'folder', title: 'Two', containerId: '__root__', folder: 'Two', noteCount: 3 },
      { id: 'Three', type: 'folder', title: 'Three', containerId: '__root__', folder: 'Three', noteCount: 3 }
    ],
    links: [], suggestions: []
  });
  // start them all stacked on the exact same spot
  for (const id of ['One', 'Two', 'Three']) {
    const n = g.map.get(id); n.x = 450; n.y = 300; n.vx = 0; n.vy = 0;
  }
  g.reheat(1);
  for (let i = 0; i < 400; i++) g._step();

  const pairs = [['One', 'Two'], ['One', 'Three'], ['Two', 'Three']];
  let overlapping = 0;
  for (const [a, b] of pairs) {
    const na = g.map.get(a), nb = g.map.get(b);
    const d = Math.hypot(na.x - nb.x, na.y - nb.y);
    if (d < na.r + nb.r - 1) overlapping++;
  }
  ok('no folder bubbles overlap after settling', overlapping, 0);

  const finite = ['One', 'Two', 'Three'].every(id => {
    const n = g.map.get(id);
    return Number.isFinite(n.x) && Number.isFinite(n.y);
  });
  truthy('positions stay finite', finite);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
