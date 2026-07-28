// vault.js
// Reads a folder of .md files and builds a NESTED graph model:
//   - folder nodes and note nodes, each with `containerId` (the folder it lives in)
//   - edges: wikilinks (solid), shared tags (faint), parent->child (directed arrow)
// The renderer uses containerId to draw bubbles-within-bubbles with semantic zoom.

const fs = require('fs');
const path = require('path');
const { parseNote } = require('./classifier');

const ATTACH_DIR = 'attachments';
const ROOT = '';                       // the canvas itself is the root container
const IGNORE = new Set(['.synapse', ATTACH_DIR, 'node_modules', '.git']);

const toPosix = p => p.split(path.sep).join('/');

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }
  return out;
}

// every directory under root (so empty groups still appear as bubbles)
function walkDirs(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      out.push(toPosix(path.relative(root, full)));
      stack.push(full);
    }
  }
  return out;
}

function scan(root) {
  const files = walk(root);
  const noteNodes = [];
  const byTitle = new Map();      // lowercased title/basename -> note id
  const tagIndex = new Map();     // tag -> [note ids]
  const folderIds = new Set();    // every folder that must exist as a node

  for (const file of files) {
    let raw = '';
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const parsed = parseNote(raw);
    const rel = toPosix(path.relative(root, file));
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ROOT;
    const base = path.basename(file, '.md');
    const title = parsed.title || base;

    // register this folder + all ancestor folders
    let d = dir;
    while (d && d !== ROOT) { folderIds.add(d); d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ROOT; }
    if (dir !== ROOT) folderIds.add(dir);

    const node = {
      id: rel, type: 'note', title,
      containerId: dir,
      folder: dir === ROOT ? 'Inbox' : dir.split('/').pop(),
      tags: parsed.tags, links: parsed.links,
      parentNote: parsed.parent || null,
      created: parsed.created, path: file,
      excerpt: parsed.body.replace(/\s+/g, ' ').trim().slice(0, 160),
      // full-text search blob: title + tags + body (so search reads CONTENT, not folders)
      search: (title + ' ' + parsed.tags.join(' ') + ' ' + parsed.body).toLowerCase()
    };
    noteNodes.push(node);
    byTitle.set(title.toLowerCase(), rel);
    byTitle.set(base.toLowerCase(), rel);
    for (const t of parsed.tags) {
      if (!tagIndex.has(t)) tagIndex.set(t, []);
      tagIndex.get(t).push(rel);
    }
  }

  // include every directory (even empty groups)
  for (const d of walkDirs(root)) folderIds.add(d);

  // folder nodes
  const folderNodes = [...folderIds].map(id => ({
    id, type: 'folder',
    title: id.split('/').pop(),
    containerId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ROOT,
    folder: id.split('/').pop()
  }));

  // descendant note counts (for bubble sizing)
  const count = new Map();
  for (const n of noteNodes) {
    let c = n.containerId;
    while (c && c !== ROOT) { count.set(c, (count.get(c) || 0) + 1); c = c.includes('/') ? c.slice(0, c.lastIndexOf('/')) : ROOT; }
  }
  for (const f of folderNodes) f.noteCount = count.get(f.id) || 0;

  // ---- edges ----
  const links = [];
  const seen = new Set();
  const add = (a, b, type, directed) => {
    if (a === b) return;
    const key = (directed ? a + '>' + b : [a, b].sort().join('~')) + ':' + type;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ source: a, target: b, type });
  };

  const noteIds = new Set(noteNodes.map(n => n.id));
  for (const n of noteNodes) {
    for (const l of n.links) {
      const t = byTitle.get(l.toLowerCase());
      if (t) add(n.id, t, 'wikilink', false);
    }
    if (n.parentNote) {
      const p = noteIds.has(n.parentNote) ? n.parentNote : byTitle.get(String(n.parentNote).toLowerCase());
      if (p) add(p, n.id, 'parent', true);   // parent -> child (directed)
    }
  }
  for (const [, ids] of tagIndex) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        add(ids[i], ids[j], 'tag', false);
  }

  // ---- suggested links: note pairs that SHARE tags but aren't yet linked ----
  const linked = new Set(links.filter(l => l.type === 'wikilink' || l.type === 'parent')
    .map(l => [l.source, l.target].sort().join('~')));
  const sug = new Map();  // key -> {a,b,shared}
  for (const [, ids] of tagIndex) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const key = [ids[i], ids[j]].sort().join('~');
        if (linked.has(key)) continue;
        const s = sug.get(key) || { a: ids[i], b: ids[j], shared: 0 };
        s.shared++; sug.set(key, s);
      }
  }
  const suggestions = [...sug.values()].filter(s => s.shared >= 1).sort((a, b) => b.shared - a.shared).slice(0, 400);

  // ---- master root: everything top-level lives inside one always-visible "Vault" ----
  let allNodes = [...folderNodes, ...noteNodes];
  for (const n of allNodes) if (n.containerId === ROOT) n.containerId = '__root__';
  const rootNode = { id: '__root__', type: 'root', title: 'Vault', containerId: null, noteCount: noteNodes.length };
  allNodes = [rootNode, ...allNodes];

  const folders = [...new Set(noteNodes.map(n => n.folder))].sort();
  return { nodes: allNodes, links, folders, suggestions };
}

module.exports = { scan, walk, ATTACH_DIR, ROOT };
