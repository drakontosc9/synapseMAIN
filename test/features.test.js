// Tests for the nested graph features: frontmatter edits, vault tree, graph engine.
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

// ---------- fm.js ----------
console.log('fm.js frontmatter:');
const fm = require('../fm');
{
  const src = '---\ntitle: "A"\nfolder: Ideas\ntags: [x]\n---\nbody here';
  const parts = fm.splitFM(src);
  ok('splitFM keeps order', parts.order, ['title', 'folder', 'tags']);
  ok('joinFM round-trips body', fm.splitFM(fm.joinFM(parts)).body, 'body here');

  const withParent = fm.setParentContent(src, 'Ideas/root.md');
  ok('setParent adds field', fm.getParent(withParent), 'Ideas/root.md');
  ok('clearParent removes it', fm.getParent(fm.setParentContent(withParent, null)), null);

  const chain = { 'b.md': 'a.md', 'a.md': null, 'c.md': 'b.md' };
  const rp = id => chain[id] || null;
  ok('cycle: a->c where c descends a', fm.wouldCycle('a.md', 'c.md', rp), true);
  ok('no cycle: c under a', fm.wouldCycle('c.md', 'a.md', rp), false);
}

// ---------- vault.js nested model ----------
console.log('\nvault.js nested tree:');
const vault = require('../vault');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(dir, 'Ideas/Sub'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'EmptyGroup'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Ideas/root.md'), '---\ntitle: "Root"\nfolder: Ideas\ntags: [x]\n---\nThe [[Child Note]] lives here.');
  fs.writeFileSync(path.join(dir, 'Ideas/Sub/child.md'), '---\ntitle: "Child Note"\nfolder: Sub\ntags: [x]\nparent: "Ideas/root.md"\n---\nchild body');

  const g = vault.scan(dir);
  const ids = g.nodes.map(n => n.id);
  truthy('folder Ideas exists', g.nodes.find(n => n.id === 'Ideas' && n.type === 'folder'));
  truthy('nested folder Ideas/Sub exists', g.nodes.find(n => n.id === 'Ideas/Sub'));
  truthy('empty group appears', g.nodes.find(n => n.id === 'EmptyGroup'));
  ok('child containerId is its folder', g.nodes.find(n => n.id === 'Ideas/Sub/child.md').containerId, 'Ideas/Sub');
  ok('Ideas noteCount = 2', g.nodes.find(n => n.id === 'Ideas').noteCount, 2);
  truthy('parent edge (root->child, directed)', g.links.find(l => l.type === 'parent' && l.source === 'Ideas/root.md' && l.target === 'Ideas/Sub/child.md'));
  truthy('wikilink edge exists', g.links.find(l => l.type === 'wikilink'));
  truthy('tag edge exists', g.links.find(l => l.type === 'tag'));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- graph.js runtime (headless shim) ----------
console.log('\ngraph.js semantic-zoom engine:');
{
  global.window = { devicePixelRatio: 1, addEventListener() {}, SynapseGraph: null };
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
  g.setData({
    folders: ['Ideas', 'Sub'],
    nodes: [
      { id: 'Ideas', type: 'folder', title: 'Ideas', containerId: '', folder: 'Ideas', noteCount: 2 },
      { id: 'Ideas/Sub', type: 'folder', title: 'Sub', containerId: 'Ideas', folder: 'Sub', noteCount: 1 },
      { id: 'Ideas/root.md', type: 'note', title: 'Root', containerId: 'Ideas', folder: 'Ideas', tags: ['x'], links: [] },
      { id: 'Ideas/Sub/child.md', type: 'note', title: 'Child', containerId: 'Ideas/Sub', folder: 'Sub', tags: ['x'], links: [] }
    ],
    links: [{ source: 'Ideas/root.md', target: 'Ideas/Sub/child.md', type: 'parent' }]
  });
  for (let i = 0; i < 500; i++) g._step();

  // containment: child note stays within its parent folder bubble
  const sub = g.map.get('Ideas/Sub'), child = g.map.get('Ideas/Sub/child.md');
  const inside = Math.hypot(child.x - sub.x, child.y - sub.y) <= sub.r + 1;
  truthy('containment keeps child inside its folder', inside);

  // sub-folders orbit OUTSIDE the parent, notes stay inside
  const ideas = g.map.get('Ideas'), rootNote = g.map.get('Ideas/root.md');
  truthy('sub-folder orbits outside its parent circle', Math.hypot(sub.x - ideas.x, sub.y - ideas.y) > ideas.r);
  truthy('note stays inside its parent circle', Math.hypot(rootNote.x - ideas.x, rootNote.y - ideas.y) <= ideas.r + 1);

  // semantic zoom: collapsed when small on screen, expanded when zoomed in
  g.transform.k = 0.05;
  const collapsed = g._containerAlpha('Ideas', new Map());
  g.transform.k = 3;
  const expanded = g._containerAlpha('Ideas', new Map());
  truthy('folder collapsed when zoomed out (children hidden)', collapsed < 0.02);
  truthy('folder expands when zoomed in (children shown)', expanded > 0.5);

  // focusNote sets a camera animation zoomed in enough to reveal a nested note
  g.transform.k = 1;
  g.focusNote('Ideas/Sub/child.md');
  truthy('focusNote starts a camera tween', !!g.anim);
  truthy('focusNote zooms in enough to open ancestors', g.anim.to.k > 1);

  // gesture resolution: node hit-testing at a world point (zoomed in so it's visible)
  g.transform.k = 3;
  const hit = g._nodeAtWorld(child.x, child.y, null);
  truthy('hit-test finds a node', !!hit);

  // zoomToNode on a folder animates the camera
  g.anim = null; g._zoomToNode(sub);
  truthy('clicking a folder animates zoom-in', !!g.anim && g.anim.to.k > 0);
}

// ---------- v0.3: root, search, suggestions, focus, ripples ----------
console.log('\nv0.3 vault: master root + suggestions:');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
  fs.mkdirSync(path.join(dir, 'Ideas'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Ideas/a.md'), '---\ntitle: "Graph engine"\nfolder: Ideas\ntags: [ui, graph]\n---\nForce directed layout ideas.');
  fs.writeFileSync(path.join(dir, 'Ideas/b.md'), '---\ntitle: "Zoom UX"\nfolder: Ideas\ntags: [ui]\n---\nSemantic zoom notes.');
  fs.writeFileSync(path.join(dir, 'note-c.md'), '---\ntitle: "Loose thought"\nfolder: Inbox\ntags: [graph]\n---\nA root-level note about the graph.');
  const g2 = vault.scan(dir);
  truthy('synthetic __root__ exists', g2.nodes.find(n => n.id === '__root__' && n.type === 'root'));
  ok('top-level folder reparented to root', g2.nodes.find(n => n.id === 'Ideas').containerId, '__root__');
  ok('root-level note reparented to root', g2.nodes.find(n => n.id === 'note-c.md').containerId, '__root__');
  truthy('suggestions computed (shared tags, unlinked)', g2.suggestions.length >= 1);
  truthy('note has search blob incl body', g2.nodes.find(n => n.id === 'Ideas/a.md').search.includes('force directed'));

  // ---- search.js scoring ----
  console.log('\nsearch.js ranking:');
  global.window = global.window || {};
  delete require.cache[require.resolve('../src/search.js')];
  require('../src/search.js');
  const S = global.window.SynapseSearch;
  const notes = g2.nodes;
  const r1 = S.searchNotes('zoom', notes, { exact: false });
  ok('finds note by title', r1[0].node.title, 'Zoom UX');
  const r2 = S.searchNotes('force directed', notes, { exact: false });
  truthy('body-text search works (not just titles)', r2.find(r => r.node.title === 'Graph engine'));
  const r3 = S.searchNotes('graph', notes, { exact: true });
  truthy('exact mode returns literal matches', r3.length >= 1);

  // ---- graph engine with root + focus + ripple ----
  console.log('\ngraph.js v0.3 engine:');
  global.window = { devicePixelRatio: 1, addEventListener() {}, SynapseGraph: null };
  global.requestAnimationFrame = () => 0;
  if (!global.performance) global.performance = { now: () => Date.now() };
  const canvas = { clientWidth: 900, clientHeight: 600, width: 900, height: 600, style: {}, getContext: () => new Proxy({}, { get: () => () => {} }), getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600 }), addEventListener() {} };
  delete require.cache[require.resolve('../src/graph.js')];
  require('../src/graph.js');
  const g = new global.window.SynapseGraph(canvas, {});
  g.setData(g2);
  for (let i = 0; i < 300; i++) g._step();
  ok('root container is always open (alpha 1)', g._containerAlpha('__root__', new Map()), 1);
  g.transform.k = 3;
  truthy('top-level folder still gated by zoom under root', g._containerAlpha('Ideas', new Map()) > 0.5);
  g.setFocus('Ideas/a.md');
  truthy('setFocus builds a neighbor set incl self', g.focusSet.has('Ideas/a.md'));
  g.cfg.ripples = true; g.rippleNote('Ideas/a.md');
  ok('rippleNote enqueues a ripple', g.ripples.length, 1);
  g.setConfig({ nodeScale: 2 });
  truthy('setConfig rescales note nodes', g.map.get('Ideas/a.md').r > 6);
  truthy('edgeStyle defaults to curved', g.cfg.edgeStyle === 'curved');
  g.setConfig({ edgeStyle: 'straight' });
  truthy('setConfig switches edge style', g.cfg.edgeStyle === 'straight');
  g.fit();
  truthy('fit frames the vault root children', !!g.anim);

  // staggered reveal: earlier sibling fades in before later one at mid-zoom
  g.anim = null;
  const A = g.map.get('Ideas/a.md'), B = g.map.get('Ideas/b.md'), F = g.map.get('Ideas');
  g.transform.k = (g.cfg.threshold + g.cfg.ramp * 0.4) / F.r;   // folder ~40% open
  g.setConfig({ reveal: 'fade' });
  const fA = g._nodeAlpha(A, new Map()), fB = g._nodeAlpha(B, new Map());
  truthy('fade mode: siblings reveal together (equal alpha)', Math.abs(fA - fB) < 1e-6);
  g.setConfig({ reveal: 'stagger' });
  const sA = g._nodeAlpha(A, new Map()), sB = g._nodeAlpha(B, new Map());
  const first = A._si < B._si ? sA : sB, second = A._si < B._si ? sB : sA;
  truthy('stagger mode: earlier sibling more visible mid-zoom', first > second + 0.1);
  truthy('stagger mode: all revealed when fully zoomed in', (g.transform.k = 5, g._nodeAlpha(A, new Map()) > 0.9 && g._nodeAlpha(B, new Map()) > 0.9));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
