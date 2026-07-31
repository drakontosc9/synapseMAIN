// tree.js — planning a folder-tree import.
//
// Dropping a directory should reproduce its shape in the vault: every folder
// becomes a bubble, every file becomes a note inside it, nesting preserved.
// The walk is separated from the writing so the app can show you exactly what
// it is about to do — file count, size, what it will skip — before touching
// anything.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Directories that are never worth importing as thoughts.
const IGNORE_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.venv', 'venv',
  '.idea', '.vscode', '.cache', '.next', '.nuxt', 'dist', 'out', 'build',
  'target', 'bin', 'obj', '.gradle', '.terraform', 'vendor', '.synapse'
]);

// Read into note bodies.
const TEXTUAL = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.csv', '.tsv', '.json',
  '.yml', '.yaml', '.ini', '.cfg', '.conf', '.rst', '.org'
]);

// Copied to attachments/ and embedded, because we cannot read inside them.
const EMBEDDABLE = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
  '.zip', '.7z', '.rar', '.tar', '.gz',
  '.mp3', '.wav', '.flac', '.mp4', '.mov', '.avi', '.mkv'
]);

const DEFAULTS = {
  maxFiles: 2000,
  maxDepth: 12,
  maxBytes: 256 * 1024 * 1024,   // whole tree
  maxFileBytes: 64 * 1024 * 1024,
  includeBinaries: true,
  includeHidden: false
};

function kindOf(ext) {
  if (TEXTUAL.has(ext)) return 'text';
  if (EMBEDDABLE.has(ext)) return 'binary';
  return 'other';
}

const toPosix = (p) => p.split(path.sep).join('/');

/**
 * Walk a directory and describe what importing it would produce.
 * Never writes anything.
 *
 * @returns {{
 *   root:string, name:string, folders:string[],
 *   files:{rel:string,abs:string,size:number,kind:string}[],
 *   bytes:number, skipped:{path:string,why:string}[], truncated:boolean
 * }}
 */
async function planTree(root, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const folders = [];
  const files = [];
  const skipped = [];
  let bytes = 0;
  let truncated = false;

  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length) {
    const { dir, rel, depth } = stack.shift();   // breadth-first: shallow first
    if (depth > o.maxDepth) { skipped.push({ path: toPosix(rel), why: 'deeper than ' + o.maxDepth + ' levels' }); continue; }

    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { skipped.push({ path: toPosix(rel) || '.', why: 'unreadable' }); continue; }

    // stable order so a re-import lines up with the first
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const e of entries) {
      const name = e.name;
      const childRel = rel ? rel + path.sep + name : name;
      const childAbs = path.join(dir, name);

      if (!o.includeHidden && name.startsWith('.')) { continue; }
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(name)) { skipped.push({ path: toPosix(childRel), why: 'build/system folder' }); continue; }
        folders.push(toPosix(childRel));
        stack.push({ dir: childAbs, rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;                 // symlinks, sockets, devices

      if (files.length >= o.maxFiles) { truncated = true; continue; }

      let size = 0;
      try { size = (await fsp.stat(childAbs)).size; }
      catch { skipped.push({ path: toPosix(childRel), why: 'unreadable' }); continue; }

      const ext = path.extname(name).toLowerCase();
      const kind = kindOf(ext);
      if (size > o.maxFileBytes) { skipped.push({ path: toPosix(childRel), why: 'larger than 64MB' }); continue; }
      if (kind !== 'text' && !o.includeBinaries) { skipped.push({ path: toPosix(childRel), why: 'not a text file' }); continue; }
      if (bytes + size > o.maxBytes) { truncated = true; continue; }

      bytes += size;
      files.push({ rel: toPosix(childRel), abs: childAbs, size, kind });
    }
  }

  return {
    root,
    name: path.basename(root) || 'imported',
    folders, files, bytes, skipped, truncated
  };
}

/** Same walk, synchronous — used by the tests. */
function planTreeSync(root, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const folders = [], files = [], skipped = [];
  let bytes = 0, truncated = false;
  const stack = [{ dir: root, rel: '', depth: 0 }];
  while (stack.length) {
    const { dir, rel, depth } = stack.shift();
    if (depth > o.maxDepth) { skipped.push({ path: toPosix(rel), why: 'too deep' }); continue; }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const childRel = rel ? rel + path.sep + e.name : e.name;
      const childAbs = path.join(dir, e.name);
      if (!o.includeHidden && e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) { skipped.push({ path: toPosix(childRel), why: 'build/system folder' }); continue; }
        folders.push(toPosix(childRel));
        stack.push({ dir: childAbs, rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!e.isFile()) continue;
      if (files.length >= o.maxFiles) { truncated = true; continue; }
      let size = 0;
      try { size = fs.statSync(childAbs).size; } catch { continue; }
      const kind = kindOf(path.extname(e.name).toLowerCase());
      if (size > o.maxFileBytes) { skipped.push({ path: toPosix(childRel), why: 'too large' }); continue; }
      if (kind !== 'text' && !o.includeBinaries) { skipped.push({ path: toPosix(childRel), why: 'not text' }); continue; }
      if (bytes + size > o.maxBytes) { truncated = true; continue; }
      bytes += size;
      files.push({ rel: toPosix(childRel), abs: childAbs, size, kind });
    }
  }
  return { root, name: path.basename(root) || 'imported', folders, files, bytes, skipped, truncated };
}

/** Human summary of a plan, for the confirmation dialog. */
function describePlan(plan) {
  const mb = (n) => n < 1024 * 1024
    ? (n / 1024).toFixed(0) + ' KB'
    : (n / (1024 * 1024)).toFixed(1) + ' MB';
  const text = plan.files.filter(f => f.kind === 'text').length;
  const other = plan.files.length - text;
  return {
    folders: plan.folders.length,
    files: plan.files.length,
    textFiles: text,
    otherFiles: other,
    size: mb(plan.bytes),
    skipped: plan.skipped.length,
    truncated: plan.truncated
  };
}

module.exports = {
  planTree, planTreeSync, describePlan, kindOf,
  IGNORE_DIRS, TEXTUAL, EMBEDDABLE, DEFAULTS
};
