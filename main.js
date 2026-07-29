// main.js — Electron main process.
// Owns the filesystem: choosing the vault, classifying + saving thoughts,
// reading/writing notes, and importing images / PDFs / links.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const classifier = require('./classifier');
const vault = require('./vault');
const fmlib = require('./fm');

const SETTINGS_PATH = path.join(app?.getPath ? app.getPath('userData') : os.tmpdir(), 'synapse-settings.json');
let settings = { vaultPath: null, groupCreate: 'both' };

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch {}
}
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)); } catch {}
}

function rulesPath() { return settings.vaultPath ? path.join(settings.vaultPath, '.synapse', 'rules.json') : null; }
function loadRules() {
  const custom = rulesPath();
  if (custom && fs.existsSync(custom)) { try { return JSON.parse(fs.readFileSync(custom, 'utf8')); } catch {} }
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'rules.json'), 'utf8'));
}

// ---- config / theme (travels with the vault: <vault>/.synapse/config.json) ----
const DEFAULT_CONFIG = {
  theme: 'midnight', accent: '#7c9cff',
  background: 'dots', gridSpacing: 40,
  nodeScale: 1, labelScale: 1, folderBase: 34, folderGrow: 16,
  threshold: 58, ramp: 46,
  repulsion: 4200, spring: 0.02, linkTension: 1, packing: 1,
  animSpeed: 1, inertia: true, longPressMs: 2000,
  ripples: true, sound: false, showMinimap: true, showSuggestions: false,
  reveal: 'fade',
  folderColors: {}
};
function configPath() { return settings.vaultPath ? path.join(settings.vaultPath, '.synapse', 'config.json') : null; }
function loadConfig() {
  const p = configPath();
  let stored = {};
  if (p && fs.existsSync(p)) { try { stored = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {} }
  else if (settings.config) stored = settings.config;
  return Object.assign({}, DEFAULT_CONFIG, stored);
}
function saveConfig(cfg) {
  settings.config = cfg; saveSettings();
  const p = configPath();
  if (p) { try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(cfg, null, 2)); } catch {} }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: '#0e1116',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  return win;
}

app.whenReady().then(() => {
  loadSettings();
  const win = createWindow();
  try { require('./updater').initAutoUpdate(win); } catch {}
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------

ipcMain.handle('get-vault', () => settings.vaultPath);

ipcMain.handle('choose-vault', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose (or create) your Synapse vault folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return settings.vaultPath;
  settings.vaultPath = r.filePaths[0];
  saveSettings();
  ensureVaultScaffold();
  return settings.vaultPath;
});

ipcMain.handle('scan-vault', () => {
  if (!settings.vaultPath) return { nodes: [], links: [], folders: [] };
  return vault.scan(settings.vaultPath);
});

// Non-destructive: where WOULD this thought go? (for the live hint)
ipcMain.handle('preview-thought', (_e, text) => {
  if (!text || !text.trim()) return null;
  const d = classifier.classify(text, loadRules());
  return { folder: d.folder, reason: d.reason, score: d.score };
});

ipcMain.handle('capture-thought', (_e, text) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const rules = loadRules();
  const decision = classifier.classify(text, rules);
  const note = classifier.buildNote(text, decision.folder, decision.matched.filter(m => m.startsWith('#')).map(m => m.slice(1)));

  const dir = path.join(settings.vaultPath, decision.folder);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, note.slug + '.md');
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, note.slug + '-' + n++ + '.md');
  fs.writeFileSync(file, note.content, 'utf8');

  return {
    folder: decision.folder,
    title: note.title,
    reason: decision.reason,
    score: decision.score,
    path: file,
    id: path.relative(settings.vaultPath, file)
  };
});

ipcMain.handle('read-note', (_e, relId) => {
  const file = path.join(settings.vaultPath, relId);
  return fs.readFileSync(file, 'utf8');
});

ipcMain.handle('write-note', (_e, relId, content) => {
  const file = path.join(settings.vaultPath, relId);
  fs.writeFileSync(file, content, 'utf8');
  return true;
});

// Import images / PDFs: copy into <vault>/attachments and return a Markdown ref.
ipcMain.handle('import-files', async () => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const r = await dialog.showOpenDialog({
    title: 'Import images or PDFs',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Attachments', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'] }
    ]
  });
  if (r.canceled) return [];
  const attachDir = path.join(settings.vaultPath, vault.ATTACH_DIR);
  fs.mkdirSync(attachDir, { recursive: true });
  const out = [];
  for (const src of r.filePaths) {
    const base = path.basename(src);
    let dest = path.join(attachDir, base);
    let n = 2;
    while (fs.existsSync(dest)) {
      const ext = path.extname(base);
      dest = path.join(attachDir, path.basename(base, ext) + '-' + n++ + ext);
    }
    fs.copyFileSync(src, dest);
    const rel = path.posix.join(vault.ATTACH_DIR, path.basename(dest));
    const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(dest);
    out.push({ name: path.basename(dest), rel, markdown: (isImg ? '!' : '') + '[' + path.basename(dest) + '](' + rel + ')' });
  }
  return out;
});

// Save a link as its own note in a Links folder.
ipcMain.handle('import-link', (_e, url, note) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const dir = path.join(settings.vaultPath, 'Links');
  fs.mkdirSync(dir, { recursive: true });
  const title = (note && note.trim()) || url;
  const slug = classifier.slugify(title);
  const now = new Date().toISOString();
  const body = ['---', 'title: ' + JSON.stringify(title.slice(0, 60)), 'created: ' + now,
    'folder: Links', 'tags: [link]', '---', '', '[' + title + '](' + url + ')', '',
    (note || '')].join('\n');
  let file = path.join(dir, slug + '.md');
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, slug + '-' + n++ + '.md');
  fs.writeFileSync(file, body, 'utf8');
  return { id: path.relative(settings.vaultPath, file), title };
});

// Create a note that embeds freshly imported attachments (used when no note is open).
ipcMain.handle('new-attachment-note', (_e, markdownBlock) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const dir = path.join(settings.vaultPath, 'Attachments');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date();
  const title = 'Imported ' + stamp.toLocaleDateString();
  const slug = classifier.slugify(title + '-' + stamp.getTime());
  const body = ['---', 'title: ' + JSON.stringify(title), 'created: ' + stamp.toISOString(),
    'folder: Attachments', 'tags: [attachment]', '---', '', markdownBlock, ''].join('\n');
  const file = path.join(dir, slug + '.md');
  fs.writeFileSync(file, body, 'utf8');
  return { id: path.relative(settings.vaultPath, file), title };
});

ipcMain.handle('reveal', (_e, relId) => {
  shell.showItemInFolder(path.join(settings.vaultPath, relId));
});

// ---- settings ----
ipcMain.handle('get-settings', () => ({ groupCreate: settings.groupCreate || 'both' }));
ipcMain.handle('set-settings', (_e, patch) => {
  settings = Object.assign(settings, patch || {});
  saveSettings();
  return { groupCreate: settings.groupCreate };
});

// ---- config / theme ----
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('set-config', (_e, patch) => { const cfg = Object.assign(loadConfig(), patch || {}); saveConfig(cfg); return cfg; });
ipcMain.handle('reset-config', () => { const cfg = Object.assign({}, DEFAULT_CONFIG); saveConfig(cfg); return cfg; });

// ---- rules editor ----
ipcMain.handle('get-rules', () => loadRules());
ipcMain.handle('set-rules', (_e, rules) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const p = rulesPath(); fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(rules, null, 2)); return { ok: true };
});

// ---- export graph image ----
ipcMain.handle('save-image', async (_e, dataUrl) => {
  const r = await dialog.showSaveDialog({ title: 'Export graph as PNG', defaultPath: 'synapse-graph.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  return { ok: true, path: r.filePath };
});

// ---- frontmatter helpers (tested in fm.js) ----
const readParent = (relId) => {
  try { return fmlib.getParent(fs.readFileSync(path.join(settings.vaultPath, relId), 'utf8')); }
  catch { return null; }
};

// set childId's parent: field to parentId (or clear if parentId is null)
ipcMain.handle('set-parent', (_e, childId, parentId) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  if (childId === parentId) return { ok: false, reason: 'A note cannot be its own parent.' };
  if (parentId && fmlib.wouldCycle(childId, parentId, readParent)) return { ok: false, reason: 'That would create a loop.' };
  const file = path.join(settings.vaultPath, childId);
  const prev = readParent(childId);
  fs.writeFileSync(file, fmlib.setParentContent(fs.readFileSync(file, 'utf8'), parentId), 'utf8');
  return { ok: true, prev: prev || null };
});

// append a [[wikilink]] to fromId's body pointing at toId's title
ipcMain.handle('add-wikilink', (_e, fromId, toId) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const toFile = path.join(settings.vaultPath, toId);
  const { fm } = fmlib.splitFM(fs.readFileSync(toFile, 'utf8'));
  const title = (fm.title ? String(fm.title).replace(/^"|"$/g, '') : path.basename(toId, '.md'));
  const fromFile = path.join(settings.vaultPath, fromId);
  let content = fs.readFileSync(fromFile, 'utf8');
  const link = '[[' + title + ']]';
  if (content.includes(link)) return { ok: true, already: true };
  content = content.replace(/\s*$/, '') + '\n\nRelated: ' + link + '\n';
  fs.writeFileSync(fromFile, content, 'utf8');
  return { ok: true, title };
});

// create an empty folder (group). parentDir is a relative folder id or '' for root.
ipcMain.handle('create-folder', (_e, name, parentDir) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '').trim() || 'New Group';
  const rel = parentDir ? parentDir + '/' + safe : safe;
  const dir = path.join(settings.vaultPath, rel);
  fs.mkdirSync(dir, { recursive: true });
  // drop a hidden keep-file so empty folders still appear
  const keep = path.join(dir, '.keep');
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  return { id: rel, title: safe };
});

// move selected notes into a new folder (explicit grouping)
ipcMain.handle('group-notes', (_e, ids, folderName) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const safe = String(folderName).replace(/[\\/:*?"<>|]/g, '').trim() || 'New Group';
  const dir = path.join(settings.vaultPath, safe);
  fs.mkdirSync(dir, { recursive: true });
  const moved = [];
  for (const id of ids) {
    const src = path.join(settings.vaultPath, id);
    if (!fs.existsSync(src)) continue;
    let dest = path.join(dir, path.basename(id));
    let n = 2;
    while (fs.existsSync(dest)) { const e = path.extname(dest); dest = path.join(dir, path.basename(id, e) + '-' + n++ + e); }
    // keep frontmatter folder field in sync
    try {
      const parts = fmlib.splitFM(fs.readFileSync(src, 'utf8'));
      parts.fm.folder = safe; if (!parts.order.includes('folder')) parts.order.push('folder');
      fs.writeFileSync(src, fmlib.joinFM(parts), 'utf8');
    } catch {}
    fs.renameSync(src, dest);
    moved.push({ from: id, to: path.relative(settings.vaultPath, dest).split(path.sep).join('/') });
  }
  return { id: safe, moved };
});

// move a note into a folder id ('' = vault root) — used for undo & drag-to-folder
ipcMain.handle('move-note', (_e, id, folderId) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const src = path.join(settings.vaultPath, id);
  if (!fs.existsSync(src)) return { ok: false };
  const destDir = path.join(settings.vaultPath, folderId || '');
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(id));
  let n = 2; while (fs.existsSync(dest) && path.relative(dest, src) !== '') { const e = path.extname(dest); dest = path.join(destDir, path.basename(id, e) + '-' + n++ + e); }
  try { const parts = fmlib.splitFM(fs.readFileSync(src, 'utf8')); parts.fm.folder = (folderId ? folderId.split('/').pop() : 'Inbox'); if (!parts.order.includes('folder')) parts.order.push('folder'); fs.writeFileSync(src, fmlib.joinFM(parts), 'utf8'); } catch {}
  fs.renameSync(src, dest);
  return { ok: true, to: path.relative(settings.vaultPath, dest).split(path.sep).join('/') };
});

function ensureVaultScaffold() {
  const cfgDir = path.join(settings.vaultPath, '.synapse');
  fs.mkdirSync(cfgDir, { recursive: true });
  const rulesDest = path.join(cfgDir, 'rules.json');
  if (!fs.existsSync(rulesDest)) {
    fs.copyFileSync(path.join(__dirname, 'rules.json'), rulesDest);
  }
}
