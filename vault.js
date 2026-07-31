// vault.js
// Reads a folder of .md files and builds a NESTED graph model:
//   - folder nodes and note nodes, each with `containerId` (the folder it lives in)
//   - edges: wikilinks (solid), shared tags (faint), parent->child (directed arrow)
// The renderer uses containerId to draw bubbles-within-bubbles with semantic zoom.
//
// Two entry points share one cache:
//   scan(root)      - synchronous (used by the tests)
//   scanAsync(root) - non-blocking (used by the app, so a 1000-note vault does
//                     not freeze the main process on every edit)
// Parsed notes are cached by mtime+size, so a rescan after one edit re-reads one
// file instead of all of them.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { parseNote } = require('./classifier');

const ATTACH_DIR = 'attachments';
const ROOT = '';                       // the canvas itself is the root container
const IGNORE = new Set(['.synapse', ATTACH_DIR, 'node_modules', '.git']);

const toPosix = p => p.split(path.sep).join('/');

// ---------- parse cache ----------
// The cache holds a *digest*, never the raw body. Keeping `parsed.body` around
// meant every note was resident twice — once as the body, once again inside the
// lowercased search blob — which is the whole vault duplicated in memory.
// Deriving the few fields the graph needs and dropping the body fixes that, and
// bounds what crosses IPC to the renderer on every scan.
const EXCERPT_CHARS = 160;
const EXCERPT_SCAN = 800;     // raw prefix long enough to still yield a full excerpt
const SEARCH_CHARS = 4000;    // per-note ceiling on searchable body text

const cache = new Map();               // absolute path -> { mtimeMs, size, digest }

/**
 * Reduce a parsed note to what the graph actually uses, so the body can be
 * released. `base` is the filename without extension, kept searchable.
 */
function digestOf(parsed, base) {
  const body = parsed.body || '';
  return {
    title: parsed.title,
    created: parsed.created,
    folder: parsed.folder,
    parent: parsed.parent,
    expires: parsed.expires,
    tags: parsed.tags,
    links: parsed.links,
    mass: body.length,
    // collapse whitespace on a short prefix rather than the entire document
    excerpt: body.slice(0, EXCERPT_SCAN).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS),
    // search.js already folds in title and tags at query time, so this is the
    // body alone — and only as much of it as is worth holding
    search: (base + ' ' + body.slice(0, SEARCH_CHARS)).toLowerCase()
  };
}

function clearCache() { cache.clear(); }

function cached(file, stat) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.digest;
  return null;
}
function remember(file, stat, digest) {
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, digest });
  return digest;
}

// ---------- directory traversal ----------
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

// Async traversal returning both .md files and every directory in one pass.
async function walkAllAsync(root) {
  const files = [];
  const dirs = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { dirs.push(toPosix(path.relative(root, full))); stack.push(full); }
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) files.push(full);
    }
  }
  return { files, dirs };
}

// ---------- reading ----------
function readOne(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const hit = cached(file, stat);
  if (hit) return hit;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  return remember(file, stat, digestOf(parseNote(raw), path.basename(file, '.md')));
}

async function readOneAsync(file) {
  let stat;
  try { stat = await fsp.stat(file); } catch { return null; }
  const hit = cached(file, stat);
  if (hit) return hit;
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return null; }
  return remember(file, stat, digestOf(parseNote(raw), path.basename(file, '.md')));
}

// ---------- model building ----------
// entries: [{ file, parsed }]  dirs: ['Ideas', 'Ideas/Sub', ...]
/**
 * A "folder note" is a Markdown file whose name matches the folder it sits in
 * (Ideas/Ideas.md). It is the folder's own page: its tags, its links and its
 * parent belong to the folder bubble rather than appearing as a separate dot
 * inside it. This is what makes folders linkable through the ordinary
 * [[wikilink]] machinery — the link is a real line in a real file.
 */
function folderNoteFor(rel) {
  if (!rel.includes('/')) return null;
  const dir = rel.slice(0, rel.lastIndexOf('/'));
  const base = path.basename(rel, '.md');
  return base.toLowerCase() === dir.split('/').pop().toLowerCase() ? dir : null;
}

function buildModel(root, entries, dirs) {
  const noteNodes = [];
  const byTitle = new Map();      // lowercased title/basename -> note id
  const tagIndex = new Map();     // tag -> [note ids]
  const folderIds = new Set();    // every folder that must exist as a node
  const folderMeta = new Map();   // folder id -> data from its folder note

  for (const { file, parsed } of entries) {
    const rel = toPosix(path.relative(root, file));
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ROOT;
    const base = path.basename(file, '.md');
    const title = parsed.title || base;

    // Folder notes describe their folder; they are not separate nodes.
    const owns = folderNoteFor(rel);
    if (owns) {
      let d = owns;
      while (d && d !== ROOT) { folderIds.add(d); d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ROOT; }
      folderMeta.set(owns, {
        noteFile: rel, tags: parsed.tags, links: parsed.links,
        parentNote: parsed.parent || null,
        excerpt: parsed.excerpt,
        search: parsed.search
      });
      for (const t of parsed.tags) {
        if (!tagIndex.has(t)) tagIndex.set(t, []);
        tagIndex.get(t).push(owns);
      }
      byTitle.set(title.toLowerCase(), owns);
      byTitle.set(base.toLowerCase(), owns);
      continue;
    }

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
      // burner notes carry a self-destruct time
      expires: parsed.expires ? String(parsed.expires).replace(/^"|"$/g, '') : null,
      // "mass": how much substance this note has, used for gravitational sizing
      mass: parsed.mass,
      excerpt: parsed.excerpt,
      // bounded body text, so search still reads CONTENT rather than folders
      search: parsed.search
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
  for (const d of dirs) folderIds.add(d);

  // folder nodes — enriched with whatever their folder note says
  const folderNodes = [...folderIds].map(id => {
    const meta = folderMeta.get(id) || {};
    return {
      id, type: 'folder',
      title: id.split('/').pop(),
      containerId: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ROOT,
      folder: id.split('/').pop(),
      // present only when the folder has a folder note
      noteFile: meta.noteFile || null,
      tags: meta.tags || [],
      links: meta.links || [],
      parentNote: meta.parentNote || null,
      excerpt: meta.excerpt || '',
      search: meta.search || id.split('/').pop().toLowerCase()
    };
  });
  // folders are addressable by their own name too, so [[Ideas]] finds the bubble
  for (const f of folderNodes) {
    if (!byTitle.has(f.title.toLowerCase())) byTitle.set(f.title.toLowerCase(), f.id);
    byTitle.set(f.id.toLowerCase(), f.id);
  }

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

  // Folders link exactly like notes do — the edge just terminates on a bubble.
  const linkable = [...noteNodes, ...folderNodes];
  const knownIds = new Set(linkable.map(n => n.id));
  for (const n of linkable) {
    for (const l of (n.links || [])) {
      const t = byTitle.get(String(l).toLowerCase());
      if (t) add(n.id, t, 'wikilink', false);
    }
    if (n.parentNote) {
      const p = knownIds.has(n.parentNote)
        ? n.parentNote
        : (byTitle.get(String(n.parentNote).toLowerCase()) ||
           byTitle.get(String(n.parentNote).replace(/\.md$/i, '').toLowerCase()));
      if (p && p !== n.id) add(p, n.id, 'parent', true);   // parent -> child (directed)
    }
  }

  // Every node also has an *effective* parent: an explicit `parent:` if it has
  // one, otherwise the folder that contains it. Sizing and the skills lens use
  // this, so a folder genuinely acts as the parent of what it holds.
  for (const n of linkable) {
    let ep = null;
    if (n.parentNote) {
      ep = knownIds.has(n.parentNote) ? n.parentNote : byTitle.get(String(n.parentNote).toLowerCase());
    }
    if (!ep || ep === n.id) ep = (n.containerId && n.containerId !== ROOT) ? n.containerId : null;
    n.effectiveParent = ep || null;
  }
  // A tag shared by many notes produces n^2 edges: one #todo across 500 notes is
  // 125k pairs, which is both slow and meaningless — at that point the tag says
  // nothing about any particular pair. Skip those, but report them (see
  // `busyTags` below) so the omission is visible rather than silent.
  const MAX_TAG_FANOUT = 80;
  const busyTags = [];
  for (const [tag, ids] of tagIndex) {
    if (ids.length > MAX_TAG_FANOUT) { busyTags.push({ tag, count: ids.length }); continue; }
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++)
        add(ids[i], ids[j], 'tag', false);
  }
  busyTags.sort((a, b) => b.count - a.count);

  // ---- suggested links: note pairs that SHARE tags but aren't yet linked ----
  const linked = new Set(links.filter(l => l.type === 'wikilink' || l.type === 'parent')
    .map(l => [l.source, l.target].sort().join('~')));
  const sug = new Map();  // key -> {a,b,shared}
  for (const [, ids] of tagIndex) {
    if (ids.length > MAX_TAG_FANOUT) continue;
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
  return { nodes: allNodes, links, folders, suggestions, busyTags };
}

function scan(root) {
  const entries = [];
  for (const file of walk(root)) {
    const parsed = readOne(file);
    if (parsed) entries.push({ file, parsed });
  }
  return buildModel(root, entries, walkDirs(root));
}

async function scanAsync(root) {
  const { files, dirs } = await walkAllAsync(root);
  const entries = [];
  // read in modest batches: enough concurrency to be fast, not enough to
  // exhaust file handles on a large vault
  const BATCH = 32;
  for (let i = 0; i < files.length; i += BATCH) {
    const slice = files.slice(i, i + BATCH);
    const parsedList = await Promise.all(slice.map(readOneAsync));
    for (let j = 0; j < slice.length; j++) {
      if (parsedList[j]) entries.push({ file: slice[j], parsed: parsedList[j] });
    }
  }
  return buildModel(root, entries, dirs);
}

module.exports = { scan, scanAsync, walk, clearCache, ATTACH_DIR, ROOT };
