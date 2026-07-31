// main.js — Electron main process.
// Owns the filesystem: choosing the vault, classifying + saving thoughts,
// reading/writing notes, and importing images / PDFs / links.

const {
  app, BrowserWindow, ipcMain, dialog, shell,
  Menu, Tray, nativeImage, globalShortcut, screen
} = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const log = require('./log');
const { writeFileAtomic, writeJsonAtomic, resolveInVault, sanitizeName } = require('./safeio');
const classifier = require('./classifier');
const vault = require('./vault');
const fmlib = require('./fm');

const SETTINGS_PATH = path.join(app?.getPath ? app.getPath('userData') : os.tmpdir(), 'synapse-settings.json');
const DEFAULT_SHORTCUT = 'Control+Shift+Space';

let settings = {
  vaultPath: null,
  groupCreate: 'both',
  quickShortcut: DEFAULT_SHORTCUT,
  quickCaptureEnabled: true,
  runInTray: false,
  window: null
};

let mainWindow = null;
let quickWindow = null;
let tray = null;
let isQuitting = false;

// True once the on-disk settings have been read (or shown not to exist). Until
// then we must not write: an early save would persist bare defaults over a
// perfectly good config.
let settingsLoaded = false;
// Set only when the user deliberately picks (or clears) a vault, so an
// in-memory null can never silently overwrite a stored path.
let vaultExplicitlySet = false;

function loadSettings() {
  let raw = null;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') { settingsLoaded = true; return; }   // first run
    log.error('could not read settings: ', err);
    return;                                                         // stays unloaded: no writes
  }
  try {
    settings = Object.assign(settings, JSON.parse(raw));
    settingsLoaded = true;
  } catch (err) {
    // Corrupt file. Keep a copy so the vault path is recoverable by hand, and
    // refuse to write until the user makes a deliberate choice.
    log.error('settings file is not valid JSON — keeping a backup and starting fresh: ', err);
    try { fs.writeFileSync(SETTINGS_PATH + '.corrupt', raw); } catch {}
    settingsLoaded = true;
  }
}

function saveSettings() {
  if (!settingsLoaded) {
    log.warn('refusing to save settings before they were loaded');
    return;
  }
  try {
    // Guard: if we somehow hold no vault but disk remembers one, keep disk's.
    if (!settings.vaultPath && !vaultExplicitlySet) {
      try {
        const onDisk = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        if (onDisk && onDisk.vaultPath) {
          log.warn('kept the stored vault path instead of overwriting it with null');
          settings.vaultPath = onDisk.vaultPath;
        }
      } catch {}
    }
    writeJsonAtomic(SETTINGS_PATH, settings);
  } catch (err) {
    log.error('could not save settings — vault choice may not persist: ', err);
  }
}

function rulesPath() { return settings.vaultPath ? path.join(settings.vaultPath, '.synapse', 'rules.json') : null; }
function loadRules() {
  const custom = rulesPath();
  if (custom && fs.existsSync(custom)) {
    try { return JSON.parse(fs.readFileSync(custom, 'utf8')); }
    catch (err) { log.warn('vault rules.json is invalid, using defaults: ', err); }
  }
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
  reveal: 'fade', edgeStyle: 'curved',
  folderColors: {},
  // workspace tabs travel with the vault
  tabs: [], activeTabId: null, splitTabId: null
};
function configPath() { return settings.vaultPath ? path.join(settings.vaultPath, '.synapse', 'config.json') : null; }
function loadConfig() {
  const p = configPath();
  let stored = {};
  if (p && fs.existsSync(p)) {
    try { stored = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (err) { log.warn('vault config.json is invalid, using defaults: ', err); }
  } else if (settings.config) stored = settings.config;
  return Object.assign({}, DEFAULT_CONFIG, stored);
}
function saveConfig(cfg) {
  settings.config = cfg; saveSettings();
  const p = configPath();
  if (p) {
    try { writeJsonAtomic(p, cfg); }
    catch (err) { log.error('could not save vault config: ', err); }
  }
}

// ---------- window state ----------
// Electron has no built-in save/restore for window bounds, so persist them
// ourselves and sanity-check them against the displays that exist right now
// (a window restored onto an unplugged monitor is invisible and unrecoverable).
function savedBounds() {
  const w = settings.window;
  if (!w || !Number.isFinite(w.width) || !Number.isFinite(w.height)) return null;
  if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) return { width: w.width, height: w.height };
  const visible = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return w.x < a.x + a.width && w.x + w.width > a.x && w.y < a.y + a.height && w.y + w.height > a.y;
  });
  return visible ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width: w.width, height: w.height };
}
function rememberBounds(win) {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  const maximized = win.isMaximized();
  const b = maximized ? (settings.window || {}) : win.getBounds();
  settings.window = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
  saveSettings();
}

function createWindow() {
  const restored = savedBounds();
  const win = new BrowserWindow(Object.assign({
    width: 1200,
    height: 820,
    minWidth: 780,
    minHeight: 560,
    backgroundColor: '#0e1116',
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  }, restored || {}));

  if (settings.window && settings.window.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  hardenWebContents(win.webContents, win);

  let saveTimer = null;
  const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => rememberBounds(win), 400); };
  win.on('resize', queueSave);
  win.on('move', queueSave);
  win.on('maximize', queueSave);
  win.on('unmaximize', queueSave);

  win.on('close', (e) => {
    if (settings.runInTray && !isQuitting) { e.preventDefault(); win.hide(); return; }
    rememberBounds(win);
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });

  return win;
}

// Only http(s)/mailto ever leave the app, and they leave through the OS browser.
function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') {
      shell.openExternal(url);
      return true;
    }
  } catch {}
  log.warn('blocked external navigation: ' + url);
  return false;
}

// A note's Markdown can contain arbitrary links. Without these guards, clicking
// one either navigates the app window away from index.html (leaving a dead
// window with no back button) or spawns a chrome-less BrowserWindow.
function hardenWebContents(wc, win) {
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url === wc.getURL()) return;      // in-page / reload
    e.preventDefault();
    openExternal(url);
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('render-process-gone', (_e, details) => {
    log.error('renderer gone: ' + JSON.stringify(details));
    if (win && !win.isDestroyed()) {
      dialog.showMessageBox(win, {
        type: 'error', buttons: ['Reload', 'Quit'], defaultId: 0, cancelId: 1,
        title: 'Synapse stopped responding',
        message: 'The window crashed (' + details.reason + ').',
        detail: 'Your notes are plain files on disk and are safe. Reload to continue.'
      }).then(r => { if (r.response === 0) win.reload(); else app.quit(); }).catch(() => {});
    }
  });
  wc.on('unresponsive', () => log.warn('renderer unresponsive'));
}

// ---------- quick capture ----------
// The whole premise of the app is that capture is frictionless, which means it
// has to work without finding or launching the window first.
function createQuickWindow() {
  const win = new BrowserWindow({
    width: 620, height: 132,
    frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    transparent: false, backgroundColor: '#00000000',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'src', 'quick.html'));
  hardenWebContents(win.webContents, win);
  win.on('blur', () => { if (!win.isDestroyed() && win.isVisible()) win.hide(); });
  win.on('close', (e) => { if (!isQuitting) { e.preventDefault(); win.hide(); } });
  return win;
}

function showQuickCapture() {
  if (!quickWindow || quickWindow.isDestroyed()) quickWindow = createQuickWindow();
  // centre on whichever display the cursor is on
  try {
    const pt = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(pt).workArea;
    const [w, h] = quickWindow.getSize();
    quickWindow.setPosition(
      Math.round(area.x + (area.width - w) / 2),
      Math.round(area.y + area.height * 0.28)
    );
  } catch (err) { log.warn('could not position quick capture: ', err); }
  quickWindow.show();
  quickWindow.focus();
  quickWindow.webContents.send('quick-reset');
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  if (!settings.quickCaptureEnabled) return { ok: true, registered: false };
  const accel = settings.quickShortcut || DEFAULT_SHORTCUT;
  try {
    const ok = globalShortcut.register(accel, showQuickCapture);
    if (!ok) {
      log.warn('global shortcut rejected (already taken?): ' + accel);
      return { ok: false, error: accel + ' is already used by another app.' };
    }
    log.info('quick capture bound to ' + accel);
    return { ok: true, registered: true };
  } catch (err) {
    log.error('could not register shortcut: ', err);
    return { ok: false, error: String(err.message || err) };
  }
}

// ---------- tray ----------
function createTray() {
  try {
    let img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Synapse');
    refreshTrayMenu();
    tray.on('click', showMain);
  } catch (err) {
    log.warn('could not create tray icon: ', err);
  }
}
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Quick capture', accelerator: settings.quickShortcut, click: showQuickCapture },
    { label: 'Open Synapse', click: showMain },
    { type: 'separator' },
    { label: settings.vaultPath ? 'Vault: ' + path.basename(settings.vaultPath) : 'No vault chosen', enabled: false },
    { label: 'Reveal vault folder', enabled: !!settings.vaultPath, click: () => settings.vaultPath && shell.openPath(settings.vaultPath) },
    { type: 'separator' },
    { label: 'Quit Synapse', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function showMain() {
  if (!mainWindow || mainWindow.isDestroyed()) { mainWindow = createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------- application menu ----------
// Without this the app inherits Electron's default menu and, more importantly,
// has no Edit roles — which is how clipboard shortcuts are guaranteed to work
// in text fields.
function buildMenu() {
  const send = (action) => () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMain();
      mainWindow.webContents.send('menu-action', action);
    }
  };
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'New thought', accelerator: 'CmdOrCtrl+N', click: send('new-thought') },
        { label: 'Quick capture', accelerator: settings.quickShortcut, click: showQuickCapture },
        { type: 'separator' },
        { label: 'Choose vault folder…', click: send('choose-vault') },
        { label: 'Reveal vault in file manager', enabled: !!settings.vaultPath, click: () => settings.vaultPath && shell.openPath(settings.vaultPath) },
        { type: 'separator' },
        { label: 'Export graph as PNG…', accelerator: 'CmdOrCtrl+Shift+E', click: send('export-png') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('open-settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Quit Synapse' }
      ]
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' }] : []),
        { role: 'delete' }, { type: 'separator' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find note', accelerator: 'CmdOrCtrl+F', click: send('focus-search') },
        { label: 'Command palette', accelerator: 'CmdOrCtrl+K', click: send('palette') }
      ]
    },
    {
      label: '&View',
      submenu: [
        { label: 'Fit graph to view', accelerator: 'CmdOrCtrl+0', click: send('fit') },
        { label: 'Reload vault from disk', accelerator: 'CmdOrCtrl+R', click: send('rescan') },
        { label: 'Recent notes', accelerator: 'CmdOrCtrl+E', click: send('recents') },
        { type: 'separator' },
        { label: 'New tab from selection', accelerator: 'CmdOrCtrl+T', click: send('new-tab') },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        { label: 'Toggle split view', accelerator: 'CmdOrCtrl+\\', click: send('split') },
        { label: 'Cycle layout lens', accelerator: 'CmdOrCtrl+L', click: send('cycle-lens') },
        { type: 'separator' },
        { label: 'Cycle theme', accelerator: 'CmdOrCtrl+Shift+T', click: send('cycle-theme') },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Reload window', accelerator: 'CmdOrCtrl+Shift+R', click: () => mainWindow && mainWindow.reload() },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: '&Help',
      submenu: [
        { label: 'How to use Synapse', click: send('open-help') },
        // opens Settings on the same panel as the button, so there is one place
        // that answers "am I up to date?"
        { label: 'Check for updates…', click: send('check-updates') },
        { label: 'Open log file', click: () => { const f = log.file(); if (f) shell.showItemInFolder(f); } },
        { type: 'separator' },
        { label: 'About Synapse ' + app.getVersion(), click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'About Synapse',
            message: 'Synapse ' + app.getVersion(),
            detail: 'Electron ' + process.versions.electron + '  ·  Node ' + process.versions.node +
                    '\nVault: ' + (settings.vaultPath || 'none chosen') +
                    '\nLog: ' + (log.file() || 'unavailable')
          }).catch(() => {});
        } }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- vault watcher ----------
// The README promises you can edit the same vault in Obsidian. Without a watcher
// those edits stay invisible until the user happens to press rescan.
let watcher = null, watchTimer = null, suppressWatchUntil = 0;

function touched() { suppressWatchUntil = Date.now() + 900; }   // our own writes

function stopWatch() {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  clearTimeout(watchTimer);
}
function startWatch() {
  stopWatch();
  if (!settings.vaultPath) return;
  try {
    watcher = fs.watch(settings.vaultPath, { recursive: true }, (_evt, file) => {
      const name = String(file || '');
      if (name.startsWith('.synapse') || name.includes('.tmp') || name.startsWith('.')) return;
      if (Date.now() < suppressWatchUntil) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        log.info('vault changed on disk: ' + name);
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('vault-changed');
        }
      }, 450);
    });
    watcher.on('error', (err) => log.warn('vault watch error: ', err));
    log.info('watching vault for external edits');
  } catch (err) {
    log.warn('could not watch vault (external edits need manual rescan): ', err);
  }
}

// ---------- lifecycle ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second copy would race the first one writing the same vault files.
  // Log it before quitting: if the holder is a zombie with no window, the user
  // sees an app that "won't start" and otherwise has nothing to go on.
  try {
    log.init(app.getPath('logs'));
    log.warn('another Synapse instance already holds the lock — focusing it and exiting');
  } catch {}
  app.quit();
} else {
  app.on('second-instance', () => { showMain(); });

  app.whenReady().then(() => {
    log.init(app.getPath('logs'));
    log.info('Synapse ' + app.getVersion() + ' starting on ' + process.platform);

    process.on('uncaughtException', (err) => log.error('uncaughtException: ', err));
    process.on('unhandledRejection', (reason) => log.error('unhandledRejection: ', reason));

    loadSettings();
    buildMenu();
    mainWindow = createWindow();
    createTray();
    const shortcut = registerShortcut();
    if (!shortcut.ok) {
      mainWindow.webContents.once('did-finish-load', () =>
        mainWindow.webContents.send('shortcut-failed', shortcut.error));
    }
    startWatch();

    // burner notes self-destruct: sweep at launch, then hourly
    try { purgeExpired(); } catch (err) { log.warn('burner sweep failed: ', err); }
    setInterval(() => { try { purgeExpired(); } catch (err) { log.warn('burner sweep failed: ', err); } }, 15 * 60 * 1000);

    try { require('./updater').initAutoUpdate(mainWindow); }
    catch (err) { log.warn('auto-update unavailable: ', err); }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
      else showMain();
    });
  });
}

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopWatch(); });

app.on('window-all-closed', () => {
  if (settings.runInTray) return;             // living in the tray
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC ----------
// Every handler is wrapped so a failure is logged instead of vanishing, and
// every path from the renderer is checked to be inside the vault.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try { return await fn(event, ...args); }
    catch (err) {
      log.error('ipc ' + channel + ' failed: ', err);
      throw new Error(err && err.message ? err.message : String(err));
    }
  });
}
function inVault(relId) {
  const abs = resolveInVault(settings.vaultPath, relId);
  if (!abs) {
    log.warn('refused path outside vault: ' + relId);
    throw new Error('That file is outside your vault.');
  }
  return abs;
}
function relOf(abs) { return path.relative(settings.vaultPath, abs).split(path.sep).join('/'); }

handle('get-vault', () => settings.vaultPath);

handle('get-app-info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  logFile: log.file(),
  vaultPath: settings.vaultPath,
  quickShortcut: settings.quickShortcut || DEFAULT_SHORTCUT,
  quickCaptureEnabled: settings.quickCaptureEnabled !== false,
  runInTray: !!settings.runInTray
}));

handle('choose-vault', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Choose (or create) your Synapse vault folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return settings.vaultPath;
  settings.vaultPath = r.filePaths[0];
  vaultExplicitlySet = true;          // a deliberate choice may overwrite disk
  saveSettings();
  ensureVaultScaffold();
  vault.clearCache();
  startWatch();
  refreshTrayMenu();
  buildMenu();
  log.info('vault set to ' + settings.vaultPath);
  return settings.vaultPath;
});

handle('scan-vault', async () => {
  if (!settings.vaultPath) return { nodes: [], links: [], folders: [], suggestions: [] };
  return await vault.scanAsync(settings.vaultPath);
});

// Non-destructive: where WOULD this thought go? (for the live hint)
handle('preview-thought', (_e, text) => {
  if (!text || !text.trim()) return null;
  const d = classifier.classify(text, loadRules());
  return { folder: d.folder, reason: d.reason, score: d.score };
});

handle('capture-thought', (_e, text) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  if (!text || !String(text).trim()) throw new Error('Nothing to capture.');
  const rules = loadRules();
  const decision = classifier.classify(text, rules);
  const note = classifier.buildNote(text, decision.folder, decision.matched.filter(m => m.startsWith('#')).map(m => m.slice(1)));

  const dir = path.join(settings.vaultPath, decision.folder);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, note.slug + '.md');
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, note.slug + '-' + n++ + '.md');
  touched();
  writeFileAtomic(file, note.content, 'utf8');
  log.info('captured into ' + decision.folder);

  return {
    folder: decision.folder,
    title: note.title,
    reason: decision.reason,
    score: decision.score,
    path: file,
    id: relOf(file),
    folders: folderList()
  };
});

handle('read-note', (_e, relId) => fs.readFileSync(inVault(relId), 'utf8'));

handle('write-note', (_e, relId, content) => {
  const file = inVault(relId);
  if (typeof content !== 'string') throw new Error('Note content must be text.');
  touched();
  writeFileAtomic(file, content, 'utf8');
  return true;
});

// Move a note to the OS trash — recoverable, unlike an unlink.
handle('delete-note', async (_e, relId) => {
  const file = inVault(relId);
  touched();
  await shell.trashItem(file);
  log.info('trashed ' + relId);
  return { ok: true };
});

// Import images / PDFs: copy into <vault>/attachments and return a Markdown ref.
handle('import-files', async () => {
  if (!settings.vaultPath) return [];
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
    touched();
    fs.copyFileSync(src, dest);
    const rel = path.posix.join(vault.ATTACH_DIR, path.basename(dest));
    const isImg = /\.(png|jpe?g|gif|webp|svg)$/i.test(dest);
    out.push({ name: path.basename(dest), rel, markdown: (isImg ? '!' : '') + '[' + path.basename(dest) + '](' + rel + ')' });
  }
  return out;
});

// Save a link as its own note in a Links folder.
handle('import-link', (_e, url, note) => {
  if (!settings.vaultPath) return { error: 'No vault selected.' };
  const clean = String(url || '').trim();
  if (!/^https?:\/\/.+/i.test(clean)) return { error: 'Only http:// and https:// links can be saved.' };
  const dir = path.join(settings.vaultPath, 'Links');
  fs.mkdirSync(dir, { recursive: true });
  const title = (note && note.trim()) || clean;
  const slug = classifier.slugify(title);
  const now = new Date().toISOString();
  const body = ['---', 'title: ' + JSON.stringify(title.slice(0, 60)), 'created: ' + now,
    'folder: Links', 'tags: [link]', '---', '', '[' + title + '](' + clean + ')', '',
    (note || '')].join('\n');
  let file = path.join(dir, slug + '.md');
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, slug + '-' + n++ + '.md');
  touched();
  writeFileAtomic(file, body, 'utf8');
  return { id: relOf(file), title };
});

// Create a note that embeds freshly imported attachments (used when no note is open).
handle('new-attachment-note', (_e, markdownBlock) => {
  if (!settings.vaultPath) return { error: 'No vault selected.' };
  const dir = path.join(settings.vaultPath, 'Attachments');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date();
  const title = 'Imported ' + stamp.toLocaleDateString();
  const slug = classifier.slugify(title + '-' + stamp.getTime());
  const body = ['---', 'title: ' + JSON.stringify(title), 'created: ' + stamp.toISOString(),
    'folder: Attachments', 'tags: [attachment]', '---', '', markdownBlock, ''].join('\n');
  const file = path.join(dir, slug + '.md');
  touched();
  writeFileAtomic(file, body, 'utf8');
  return { id: relOf(file), title };
});

handle('reveal', (_e, relId) => { shell.showItemInFolder(inVault(relId)); return true; });

// The log lives in userData, outside the vault, so it needs its own channel
// rather than going through the vault-containment check.
handle('show-log', () => {
  const f = log.file();
  if (!f) return { ok: false };
  shell.showItemInFolder(f);
  return { ok: true, path: f };
});

// ---- settings ----
handle('get-settings', () => ({
  groupCreate: settings.groupCreate || 'both',
  quickShortcut: settings.quickShortcut || DEFAULT_SHORTCUT,
  quickCaptureEnabled: settings.quickCaptureEnabled !== false,
  runInTray: !!settings.runInTray
}));
handle('set-settings', (_e, patch) => {
  const before = settings.quickShortcut, beforeOn = settings.quickCaptureEnabled;
  settings = Object.assign(settings, patch || {});
  saveSettings();
  let shortcutError = null;
  if (settings.quickShortcut !== before || settings.quickCaptureEnabled !== beforeOn) {
    const r = registerShortcut();
    if (!r.ok) shortcutError = r.error;
    refreshTrayMenu(); buildMenu();
  }
  return {
    groupCreate: settings.groupCreate,
    quickShortcut: settings.quickShortcut,
    quickCaptureEnabled: settings.quickCaptureEnabled !== false,
    runInTray: !!settings.runInTray,
    shortcutError
  };
});

// ---- config / theme ----
handle('get-config', () => loadConfig());
handle('set-config', (_e, patch) => { const cfg = Object.assign(loadConfig(), patch || {}); saveConfig(cfg); return cfg; });
handle('reset-config', () => { const cfg = Object.assign({}, DEFAULT_CONFIG); saveConfig(cfg); return cfg; });

// ---- rules editor ----
handle('get-rules', () => loadRules());
handle('set-rules', (_e, rules) => {
  if (!settings.vaultPath) return { error: 'No vault selected.' };
  if (!rules || !Array.isArray(rules.rules)) return { error: 'Rules must have a "rules" array.' };
  touched();
  writeJsonAtomic(rulesPath(), rules);
  log.info('filing rules updated');
  return { ok: true };
});

// Nudge the rules when the user corrects a filing decision: the distinctive
// words of a re-filed note become keywords for the folder it was moved into.
handle('learn-filing', (_e, text, folder) => {
  if (!settings.vaultPath || !text || !folder) return { ok: false };
  const rules = loadRules();
  const words = classifier.learnableTerms(text);
  if (!words.length) return { ok: false };
  let rule = (rules.rules || []).find(r => r.folder === folder);
  if (!rule) { rule = { folder, keywords: [], tags: [] }; rules.rules = (rules.rules || []).concat([rule]); }
  rule.keywords = rule.keywords || [];
  const added = [];
  for (const w of words) {
    if (rule.keywords.some(k => k.toLowerCase() === w)) continue;
    rule.keywords.push(w); added.push(w);
    if (added.length >= 3) break;
  }
  if (!added.length) return { ok: false };
  touched();
  writeJsonAtomic(rulesPath(), rules);
  log.info('learned ' + JSON.stringify(added) + ' -> ' + folder);
  return { ok: true, added, folder };
});

// ---- export graph image ----
handle('save-image', async (_e, dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return { ok: false, error: 'Nothing to export.' };
  }
  const r = await dialog.showSaveDialog({ title: 'Export graph as PNG', defaultPath: 'synapse-graph.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  writeFileAtomic(r.filePath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  return { ok: true, path: r.filePath };
});

// ---- frontmatter helpers (tested in fm.js) ----

/** The file backing a node if it already exists — never creates one. */
function existingFileFor(relId) {
  let abs;
  try { abs = inVault(relId); } catch { return null; }
  try {
    if (fs.statSync(abs).isDirectory()) {
      const candidate = path.join(abs, path.basename(abs) + '.md');
      return fs.existsSync(candidate) ? candidate : null;
    }
    return abs;
  } catch { return null; }
}

const readParent = (relId) => {
  const f = existingFileFor(relId);
  if (!f) return null;
  try { return fmlib.getParent(fs.readFileSync(f, 'utf8')); }
  catch { return null; }
};

// set childId's parent: field to parentId (or clear if parentId is null)
handle('set-parent', (_e, childId, parentId) => {
  if (!settings.vaultPath) return { ok: false, reason: 'No vault selected.' };
  if (childId === parentId) return { ok: false, reason: 'A note cannot be its own parent.' };
  if (parentId && fmlib.wouldCycle(childId, parentId, readParent)) return { ok: false, reason: 'That would create a loop.' };
  // folders take a parent too — via their folder note
  const file = fileForNode(childId).file;
  if (parentId) inVault(parentId);
  const prev = readParent(childId);
  touched();
  writeFileAtomic(file, fmlib.setParentContent(fs.readFileSync(file, 'utf8'), parentId), 'utf8');
  return { ok: true, prev: prev || null };
});

/**
 * Resolve a graph id to the Markdown file that represents it.
 *
 * Notes are their own file. A folder is represented by its "folder note" —
 * `Ideas/Ideas.md` — which is created on demand. That is what lets folders be
 * linked and parented through exactly the same machinery as notes: the link
 * ends up as an ordinary line in an ordinary file.
 */
function fileForNode(relId) {
  const abs = inVault(relId);
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = !/\.md$/i.test(relId); }
  if (!isDir) return { file: abs, rel: relId, folder: null };

  const name = path.basename(abs);
  const noteRel = (relId ? relId + '/' : '') + name + '.md';
  const noteAbs = path.join(abs, name + '.md');
  if (!fs.existsSync(noteAbs)) {
    const now = new Date().toISOString();
    const body = ['---', 'title: ' + JSON.stringify(name), 'created: ' + now,
      'folder: ' + name, 'tags: [folder]', '---', '',
      'Notes about the **' + name + '** folder.', ''].join('\n');
    touched();
    writeFileAtomic(noteAbs, body, 'utf8');
    log.info('created folder note for ' + relId);
  }
  return { file: noteAbs, rel: noteRel, folder: relId };
}

handle('ensure-folder-note', (_e, relId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const r = fileForNode(relId);
  return { ok: true, id: r.rel, folder: r.folder };
});

// append a [[wikilink]] to fromId's body pointing at toId's title
handle('add-wikilink', (_e, fromId, toId) => {
  if (!settings.vaultPath) return { ok: false, reason: 'No vault selected.' };
  if (fromId === toId) return { ok: false, reason: 'A node cannot link to itself.' };
  const to = fileForNode(toId), from = fileForNode(fromId);
  const toFile = to.file;
  const fromFile = from.file;
  const { fm } = fmlib.splitFM(fs.readFileSync(toFile, 'utf8'));
  const title = (fm.title ? String(fm.title).replace(/^"|"$/g, '') : path.basename(toId, '.md'));
  let content = fs.readFileSync(fromFile, 'utf8');
  const link = '[[' + title + ']]';
  if (content.includes(link)) return { ok: true, already: true };
  content = content.replace(/\s*$/, '') + '\n\nRelated: ' + link + '\n';
  touched();
  writeFileAtomic(fromFile, content, 'utf8');
  return { ok: true, title };
});

// create an empty folder (group). parentDir is a relative folder id or '' for root.
handle('create-folder', (_e, name, parentDir) => {
  if (!settings.vaultPath) return { error: 'No vault selected.' };
  const safe = sanitizeName(name, 'New Group');
  const rel = parentDir ? parentDir + '/' + safe : safe;
  const dir = inVault(rel);
  if (fs.existsSync(dir)) return { error: 'A group called "' + safe + '" already exists there.' };
  touched();
  fs.mkdirSync(dir, { recursive: true });
  // drop a hidden keep-file so empty folders still appear
  const keep = path.join(dir, '.keep');
  if (!fs.existsSync(keep)) writeFileAtomic(keep, '');
  return { id: relOf(dir), title: safe };
});

// move selected notes into a new folder (explicit grouping)
handle('group-notes', (_e, ids, folderName) => {
  if (!settings.vaultPath) return { error: 'No vault selected.' };
  const safe = sanitizeName(folderName, 'New Group');
  const dir = inVault(safe);
  fs.mkdirSync(dir, { recursive: true });
  const moved = [];
  touched();
  for (const id of ids || []) {
    let src;
    try { src = inVault(id); } catch { continue; }
    if (!fs.existsSync(src)) continue;
    let dest = path.join(dir, path.basename(id));
    let n = 2;
    while (fs.existsSync(dest)) { const e = path.extname(dest); dest = path.join(dir, path.basename(id, e) + '-' + n++ + e); }
    // keep frontmatter folder field in sync
    try {
      const parts = fmlib.splitFM(fs.readFileSync(src, 'utf8'));
      parts.fm.folder = safe; if (!parts.order.includes('folder')) parts.order.push('folder');
      writeFileAtomic(src, fmlib.joinFM(parts), 'utf8');
    } catch (err) { log.warn('could not update folder field for ' + id + ': ', err); }
    fs.renameSync(src, dest);
    moved.push({ from: id, to: relOf(dest) });
  }
  return { id: safe, moved };
});

// move a note into a folder id ('' = vault root) — used for undo & re-filing
handle('move-note', (_e, id, folderId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const src = inVault(id);
  if (!fs.existsSync(src)) return { ok: false, error: 'That note no longer exists.' };
  const destDir = folderId ? inVault(folderId) : path.resolve(settings.vaultPath);
  fs.mkdirSync(destDir, { recursive: true });
  let dest = path.join(destDir, path.basename(id));
  if (path.resolve(dest) === path.resolve(src)) return { ok: true, to: id };
  let n = 2;
  while (fs.existsSync(dest)) { const e = path.extname(dest); dest = path.join(destDir, path.basename(id, e) + '-' + n++ + e); }
  touched();
  try {
    const parts = fmlib.splitFM(fs.readFileSync(src, 'utf8'));
    parts.fm.folder = (folderId ? folderId.split('/').pop() : 'Inbox');
    if (!parts.order.includes('folder')) parts.order.push('folder');
    writeFileAtomic(src, fmlib.joinFM(parts), 'utf8');
  } catch (err) { log.warn('could not update folder field for ' + id + ': ', err); }
  fs.renameSync(src, dest);
  return { ok: true, to: relOf(dest) };
});

// ---- folder operations ----

// Open a vault folder (or a note's containing folder) in the OS file manager.
handle('open-folder', async (_e, relId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const abs = relId ? inVault(relId) : path.resolve(settings.vaultPath);
  let dir = abs;
  try { if (fs.statSync(abs).isFile()) dir = path.dirname(abs); }
  catch { return { ok: false, error: 'That folder no longer exists.' }; }
  // shell.openPath resolves with an error string; '' means it opened
  const msg = await shell.openPath(dir);
  if (msg) { log.warn('openPath: ' + msg); return { ok: false, error: msg }; }
  return { ok: true, path: dir };
});

handle('rename-folder', (_e, relId, newName) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const src = inVault(relId);
  const safe = sanitizeName(newName, '');
  if (!safe) return { ok: false, error: 'Enter a folder name.' };
  const dest = path.join(path.dirname(src), safe);
  if (path.resolve(dest) === path.resolve(src)) return { ok: true, id: relId };
  if (fs.existsSync(dest)) return { ok: false, error: 'A folder called "' + safe + '" already exists here.' };
  touched();
  fs.renameSync(src, dest);
  // keep each note's `folder:` field in step with its new home
  for (const file of vault.walk(dest)) {
    try {
      const parts = fmlib.splitFM(fs.readFileSync(file, 'utf8'));
      parts.fm.folder = safe;
      if (!parts.order.includes('folder')) parts.order.push('folder');
      writeFileAtomic(file, fmlib.joinFM(parts), 'utf8');
    } catch (err) { log.warn('rename: could not update ' + file + ': ', err); }
  }
  vault.clearCache();
  log.info('renamed folder ' + relId + ' -> ' + safe);
  return { ok: true, id: relOf(dest), title: safe };
});

// Merge folder A into folder B: move every child across, then remove A.
handle('merge-folders', (_e, fromId, intoId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  if (!fromId || fromId === intoId) return { ok: false, error: 'Pick two different folders.' };
  const src = inVault(fromId);
  const dest = intoId ? inVault(intoId) : path.resolve(settings.vaultPath);
  if (path.resolve(dest).startsWith(path.resolve(src) + path.sep)) {
    return { ok: false, error: 'Cannot merge a folder into one of its own subfolders.' };
  }
  fs.mkdirSync(dest, { recursive: true });
  const destName = intoId ? intoId.split('/').pop() : 'Inbox';
  const moved = [];
  touched();
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return { ok: false, error: 'That folder no longer exists.' }; }
  for (const e of entries) {
    if (e.name === '.keep') continue;
    const from = path.join(src, e.name);
    let to = path.join(dest, e.name);
    let n = 2;
    while (fs.existsSync(to)) {
      const ext = e.isDirectory() ? '' : path.extname(e.name);
      to = path.join(dest, path.basename(e.name, ext) + '-' + n++ + ext);
    }
    if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      try {
        const parts = fmlib.splitFM(fs.readFileSync(from, 'utf8'));
        parts.fm.folder = destName;
        if (!parts.order.includes('folder')) parts.order.push('folder');
        writeFileAtomic(from, fmlib.joinFM(parts), 'utf8');
      } catch (err) { log.warn('merge: could not update ' + from + ': ', err); }
    }
    fs.renameSync(from, to);
    moved.push({ from: relOf(from), to: relOf(to) });
  }
  try { fs.rmSync(src, { recursive: true, force: true }); }
  catch (err) { log.warn('merge: could not remove empty ' + fromId + ': ', err); }
  vault.clearCache();
  log.info('merged ' + fromId + ' into ' + (intoId || 'vault root') + ' (' + moved.length + ' items)');
  return { ok: true, moved, into: intoId || '' };
});

// Move a whole folder into another folder ('' = vault root).
handle('move-folder', (_e, relId, intoId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const src = inVault(relId);
  const destParent = intoId ? inVault(intoId) : path.resolve(settings.vaultPath);
  if (path.resolve(destParent) === path.resolve(src)) return { ok: false, error: 'A folder cannot hold itself.' };
  if (path.resolve(destParent).startsWith(path.resolve(src) + path.sep)) {
    return { ok: false, error: 'Cannot move a folder into one of its own subfolders.' };
  }
  const name = path.basename(src);
  if (path.resolve(path.dirname(src)) === path.resolve(destParent)) return { ok: true, to: relId, already: true };

  fs.mkdirSync(destParent, { recursive: true });
  let dest = path.join(destParent, name);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(destParent, name + '-' + n++);
  touched();
  fs.renameSync(src, dest);
  vault.clearCache();
  log.info('moved folder ' + relId + ' -> ' + relOf(dest));
  return { ok: true, to: relOf(dest), from: relId };
});

handle('delete-folder', async (_e, relId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const dir = inVault(relId);
  const notes = vault.walk(dir).length;
  touched();
  await shell.trashItem(dir);
  vault.clearCache();
  log.info('trashed folder ' + relId + ' (' + notes + ' notes)');
  return { ok: true, notes };
});

// ---- in-graph note creation ----
// Creating a thought should not require going back to the splash screen, and
// when you create it inside a folder bubble it belongs to that folder — no
// classifier guess required.
handle('create-note', (_e, text, folderId, opts) => {
  if (!settings.vaultPath) throw new Error('No vault selected.');
  const body = String(text || '').trim();
  if (!body) throw new Error('Nothing to save.');
  const o = opts || {};

  let folder = folderId;
  let decision = null;
  if (folder == null) {                       // no explicit folder: classify
    decision = classifier.classify(body, loadRules());
    folder = decision.folder;
  }
  const dir = folder ? inVault(folder) : path.resolve(settings.vaultPath);
  fs.mkdirSync(dir, { recursive: true });

  const tags = classifier.extractTags(body);
  const note = classifier.buildNote(body, folder ? folder.split('/').pop() : 'Inbox', tags);
  let content = note.content;

  // Ephemeral "burner" note: self-destructs after the given number of hours.
  if (o.ttlHours) {
    const expires = new Date(Date.now() + Number(o.ttlHours) * 3600000).toISOString();
    const parts = fmlib.splitFM(content);
    parts.fm.expires = expires;
    if (!parts.order.includes('expires')) parts.order.push('expires');
    content = fmlib.joinFM(parts);
  }
  if (o.parent) {
    try { inVault(o.parent); content = fmlib.setParentContent(content, o.parent); }
    catch { log.warn('create-note: ignoring bad parent ' + o.parent); }
  }

  let file = path.join(dir, note.slug + '.md');
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, note.slug + '-' + n++ + '.md');
  touched();
  writeFileAtomic(file, content, 'utf8');
  log.info('created note in ' + (folder || 'vault root') + (o.ttlHours ? ' (burner ' + o.ttlHours + 'h)' : ''));
  return { id: relOf(file), title: note.title, folder: folder || 'Inbox', guessed: !!decision };
});

// ---- broad import ----
// One source of truth for which extensions are read versus attached, shared
// with the folder-tree planner.
const tree = require('./tree');
const TEXTUAL = tree.TEXTUAL;
const EMBEDDABLE = tree.EMBEDDABLE;

function copyToAttachments(src) {
  const attachDir = path.join(settings.vaultPath, vault.ATTACH_DIR);
  fs.mkdirSync(attachDir, { recursive: true });
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
  return { name: path.basename(dest), rel, markdown: (isImg ? '!' : '') + '[' + path.basename(dest) + '](' + rel + ')' };
}

/**
 * Import arbitrary files as notes. Markdown/text becomes note content (and can
 * be auto-split into linked sub-notes); anything else is copied into
 * attachments/ and wrapped in a note that previews it.
 */
handle('import-paths', (_e, paths, opts) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const o = opts || {};
  const folder = o.folder == null ? 'Imported' : o.folder;
  const dir = folder ? inVault(folder) : path.resolve(settings.vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  const skipped = [];
  touched();

  for (const src of (paths || [])) {
    let stat;
    try { stat = fs.statSync(src); } catch { skipped.push({ path: src, why: 'unreadable' }); continue; }
    if (stat.isDirectory()) { skipped.push({ path: src, why: 'folders are not imported' }); continue; }
    if (stat.size > 64 * 1024 * 1024) { skipped.push({ path: src, why: 'larger than 64MB' }); continue; }

    const ext = path.extname(src).toLowerCase();
    const base = path.basename(src, ext);

    try {
      if (TEXTUAL.has(ext)) {
        const raw = fs.readFileSync(src, 'utf8');
        if (o.split && (ext === '.md' || ext === '.markdown')) {
          const sections = classifier.splitMarkdown(raw, { minChars: 2 });
          if (sections.length > 1) {
            const parentRes = writeNoteFile(dir, base, 'Imported from ' + path.basename(src) + '\n', folder, null);
            created.push(parentRes);
            for (const s of sections) {
              created.push(writeNoteFile(dir, s.title, s.body, folder, parentRes.id));
            }
            continue;
          }
        }
        created.push(writeNoteFile(dir, base, raw, folder, o.parent || null));
      } else if (EMBEDDABLE.has(ext)) {
        const att = copyToAttachments(src);
        created.push(writeNoteFile(dir, base, att.markdown + '\n', folder, o.parent || null));
      } else {
        const att = copyToAttachments(src);
        created.push(writeNoteFile(dir, base, att.markdown + '\n', folder, o.parent || null));
      }
    } catch (err) {
      log.warn('import failed for ' + src + ': ', err);
      skipped.push({ path: src, why: 'import failed' });
    }
  }
  log.info('imported ' + created.length + ' note(s), skipped ' + skipped.length);
  return { ok: true, created, skipped, folder: folder || '' };
});

function writeNoteFile(dir, rawTitle, body, folder, parentId) {
  const title = classifier.deriveTitle(rawTitle || body || 'Untitled');
  const slug = classifier.slugify(title);
  const tags = classifier.extractTags(body);
  const now = new Date().toISOString();
  const lines = ['---', 'title: ' + JSON.stringify(title), 'created: ' + now,
    'folder: ' + (folder ? folder.split('/').pop() : 'Inbox'),
    'tags: [' + tags.join(', ') + ']'];
  if (parentId) lines.push('parent: ' + JSON.stringify(parentId));
  lines.push('---', '', String(body || '').trim(), '');
  let file = path.join(dir, slug + '.md');
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, slug + '-' + n++ + '.md');
  writeFileAtomic(file, lines.join('\n'), 'utf8');
  return { id: relOf(file), title };
}

/**
 * Drop files onto an existing note. Text is appended into the note's body;
 * anything else is copied to attachments/ and embedded. Optionally each file
 * also becomes a child note so it shows up in the graph.
 */
handle('attach-to-note', (_e, relId, paths, opts) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const file = inVault(relId);
  const o = opts || {};
  const dir = path.dirname(file);
  const attached = [], children = [], skipped = [];
  let appended = '';
  touched();

  for (const src of (paths || [])) {
    let stat;
    try { stat = fs.statSync(src); } catch { skipped.push({ path: src, why: 'unreadable' }); continue; }
    if (stat.isDirectory()) { skipped.push({ path: src, why: 'folders are not attached' }); continue; }
    const ext = path.extname(src).toLowerCase();
    const base = path.basename(src, ext);
    try {
      if (TEXTUAL.has(ext) && !o.asAttachment) {
        const raw = fs.readFileSync(src, 'utf8');
        appended += '\n\n## ' + base + '\n\n' + raw.trim() + '\n';
        attached.push({ name: path.basename(src), kind: 'text' });
      } else {
        const att = copyToAttachments(src);
        appended += '\n\n' + att.markdown + '\n';
        attached.push({ name: att.name, kind: 'file', rel: att.rel });
        if (o.alsoChildNotes) children.push(writeNoteFile(dir, base, att.markdown + '\n', relOf(dir), relId));
      }
    } catch (err) {
      log.warn('attach failed for ' + src + ': ', err);
      skipped.push({ path: src, why: 'attach failed' });
    }
  }

  if (appended) {
    const current = fs.readFileSync(file, 'utf8');
    writeFileAtomic(file, current.replace(/\s*$/, '') + appended, 'utf8');
  }
  log.info('attached ' + attached.length + ' file(s) to ' + relId);
  return { ok: true, attached, children, skipped };
});

/**
 * The Breakdown tab: ingest a file and explode it into its important parts as
 * linked child notes under a single document node.
 */
handle('breakdown-file', (_e, paths, folderId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const folder = folderId == null ? 'Breakdown' : folderId;
  const dir = folder ? inVault(folder) : path.resolve(settings.vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  const docs = [];
  const skipped = [];
  touched();

  for (const src of (paths || [])) {
    let stat;
    try { stat = fs.statSync(src); } catch { skipped.push({ path: src, why: 'unreadable' }); continue; }
    if (stat.isDirectory()) { skipped.push({ path: src, why: 'folders cannot be broken down' }); continue; }

    const ext = path.extname(src).toLowerCase();
    const base = path.basename(src, ext);

    if (!TEXTUAL.has(ext)) {
      // binary: we can still file it, we just cannot read inside it
      try {
        const att = copyToAttachments(src);
        const parent = writeNoteFile(dir, base, att.markdown + '\n', folder, null);
        docs.push({ doc: parent, parts: [], note: 'binary file — attached whole' });
      } catch (err) {
        log.warn('breakdown attach failed for ' + src + ': ', err);
        skipped.push({ path: src, why: 'could not attach' });
      }
      continue;
    }

    try {
      const raw = fs.readFileSync(src, 'utf8');
      const parts = classifier.breakdown(raw, { limit: 40 });
      const summary = ['Broken down from `' + path.basename(src) + '`',
        '', parts.length + ' part' + (parts.length === 1 ? '' : 's') + ' extracted.'].join('\n');
      const parent = writeNoteFile(dir, base, summary, folder, null);
      const made = [];
      for (const p of parts) {
        const body = p.kind === 'point' || p.kind === 'action' || p.kind === 'highlight'
          ? p.body + '\n\n#' + p.kind
          : p.body;
        made.push(writeNoteFile(dir, p.title, body, folder, parent.id));
      }
      docs.push({ doc: parent, parts: made });
      log.info('broke down ' + path.basename(src) + ' into ' + made.length + ' part(s)');
    } catch (err) {
      log.warn('breakdown failed for ' + src + ': ', err);
      skipped.push({ path: src, why: 'could not read' });
    }
  }
  return { ok: true, docs, skipped, folder: folder || '' };
});

// ---------- update checking ----------
// electron-updater only works inside a packaged app. To give an honest answer
// in both modes we ask the GitHub Releases API ourselves and compare versions;
// when we *are* packaged, we then hand off to electron-updater to do the work.

const https = require('https');
const versions = require('./version');

let lastRelease = null;   // remembered so "View release" needs no URL from the renderer

function repoInfo() {
  let pkg = {};
  try { pkg = require('./package.json'); }
  catch (err) { log.warn('could not read package.json: ', err); }
  const r = require('./repo').resolveRepo(pkg);
  if (!repoInfo._logged) { log.info('update source: ' + r.owner + '/' + r.repo + ' (via ' + r.source + ')'); repoInfo._logged = true; }
  return r;
}

function fetchJson(url, redirects) {
  const hops = redirects || 0;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Synapse-Updater', 'Accept': 'application/vnd.github+json' },
      timeout: 12000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 3) {
        res.resume();
        return resolve(fetchJson(res.headers.location, hops + 1));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 2 * 1024 * 1024) { req.destroy(new Error('response too large')); }
      });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve({ __none: true });
        if (res.statusCode === 403) return reject(new Error('GitHub rate limit reached — try again in a few minutes.'));
        if (res.statusCode !== 200) return reject(new Error('GitHub returned ' + res.statusCode));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Unreadable response from GitHub.')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timed out contacting GitHub.')));
    req.on('error', reject);
  });
}

handle('check-updates', async () => {
  const current = app.getVersion();
  const packaged = app.isPackaged;
  const repo = repoInfo();   // always resolves — worst case, the compiled-in constant

  let rel;
  try {
    rel = await fetchJson('https://api.github.com/repos/' + repo.owner + '/' + repo.repo + '/releases/latest');
  } catch (err) {
    log.warn('update check failed: ', err);
    return { ok: false, current, packaged, error: String(err.message || err) };
  }

  if (rel.__none) {
    log.info('update check: no releases published');
    return { ok: true, current, packaged, status: 'none', latest: null };
  }

  const latest = versions.clean(rel.tag_name || rel.name || '');
  const newer = versions.isNewer(latest, current);
  const assets = rel.assets || [];
  const hasInstaller = assets.some(a => /\.exe$/i.test(a.name || ''));
  const hasFeed = assets.some(a => (a.name || '').toLowerCase() === 'latest.yml');

  lastRelease = { url: rel.html_url, version: latest };
  log.info('update check: running ' + current + ', latest release ' + latest + (newer ? ' (newer)' : ' (up to date)'));

  const result = {
    ok: true, current, packaged, latest,
    repo: repo.owner + '/' + repo.repo,
    status: newer ? 'available' : 'current',
    url: rel.html_url,
    published: rel.published_at,
    notes: String(rel.body || '').slice(0, 800),
    hasInstaller, hasFeed,
    // an update can only install itself when all three line up
    canAutoInstall: !!(newer && packaged && hasFeed)
  };

  if (result.canAutoInstall) {
    // autoDownload is on, so this kicks off the download; progress arrives on
    // the existing update-status channel.
    try { await require('./updater').checkNow(mainWindow); }
    catch (err) { log.warn('handing off to electron-updater failed: ', err); }
  }
  return result;
});

handle('open-release', () => {
  if (!lastRelease || !lastRelease.url) return { ok: false };
  return openExternal(lastRelease.url) ? { ok: true } : { ok: false };
});

handle('install-update', () => {
  if (!app.isPackaged) return { ok: false, error: 'Only the installed app can restart into an update.' };
  try {
    isQuitting = true;
    require('./updater').quitAndInstall();
    return { ok: true };
  } catch (err) {
    log.error('quitAndInstall failed: ', err);
    return { ok: false, error: String(err.message || err) };
  }
});

// ---------- folder-tree import ----------
// Drop a directory and get its shape back as a graph: folders become bubbles,
// files become notes inside them, nesting preserved to the leaf.

handle('scan-tree', async (_e, paths, opts) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const plans = [];
  for (const src of (paths || [])) {
    let st;
    try { st = fs.statSync(src); } catch { continue; }
    if (!st.isDirectory()) continue;
    const plan = await tree.planTree(src, opts || {});
    plans.push({
      root: src,
      name: plan.name,
      summary: tree.describePlan(plan),
      // a shallow preview of the shape, for the confirmation dialog
      sample: plan.folders.slice(0, 12)
    });
  }
  return { ok: true, plans };
});

handle('import-tree', async (event, paths, opts) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const o = opts || {};
  const base = o.folder == null ? 'Imported' : o.folder;
  const send = (payload) => {
    try { event.sender.send('import-progress', payload); } catch {}
  };

  const results = [];
  touched();

  for (const src of (paths || [])) {
    let st;
    try { st = fs.statSync(src); } catch { continue; }
    if (!st.isDirectory()) continue;

    const plan = await tree.planTree(src, o);
    const rootName = sanitizeName(plan.name, 'Imported');
    const destRootRel = base ? base + '/' + rootName : rootName;

    // never merge into an existing folder by accident
    let finalRel = destRootRel, n = 2;
    while (fs.existsSync(inVault(finalRel))) finalRel = destRootRel + '-' + n++;
    fs.mkdirSync(inVault(finalRel), { recursive: true });

    // 1. mirror the directory structure, so empty folders still become bubbles
    const mapDir = new Map([['', finalRel]]);
    for (const relDir of plan.folders) {
      const safe = relDir.split('/').map(seg => sanitizeName(seg, 'folder')).join('/');
      const target = finalRel + '/' + safe;
      mapDir.set(relDir, target);
      fs.mkdirSync(inVault(target), { recursive: true });
      const keep = path.join(inVault(target), '.keep');
      if (!fs.existsSync(keep)) writeFileAtomic(keep, '');
    }

    // 2. convert the files
    let notes = 0, parts = 0, attachments = 0;
    const failed = [];
    let done = 0;

    for (const f of plan.files) {
      const relDir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
      const destFolder = mapDir.get(relDir) || finalRel;
      const destAbs = inVault(destFolder);
      fs.mkdirSync(destAbs, { recursive: true });
      const baseName = path.basename(f.rel, path.extname(f.rel));

      try {
        if (f.kind === 'text') {
          const raw = fs.readFileSync(f.abs, 'utf8');
          if (o.split) {
            const sections = classifier.breakdown(raw, { limit: 40 });
            if (sections.length > 1) {
              const doc = writeNoteFile(destAbs, baseName,
                'Imported from `' + f.rel + '`\n\n' + sections.length + ' parts extracted.', destFolder, null);
              notes++;
              for (const s of sections) {
                writeNoteFile(destAbs, s.title, s.body + '\n\n#' + s.kind, destFolder, doc.id);
                parts++;
              }
            } else {
              writeNoteFile(destAbs, baseName, raw, destFolder, null); notes++;
            }
          } else {
            writeNoteFile(destAbs, baseName, raw, destFolder, null); notes++;
          }
        } else {
          const att = copyToAttachments(f.abs);
          writeNoteFile(destAbs, baseName, att.markdown + '\n', destFolder, null);
          attachments++; notes++;
        }
      } catch (err) {
        log.warn('tree import failed for ' + f.rel + ': ', err);
        failed.push({ path: f.rel, why: 'could not import' });
      }

      done++;
      if (done % 25 === 0 || done === plan.files.length) {
        send({ done, total: plan.files.length, label: f.rel });
        await new Promise(r => setImmediate(r));   // keep the main process breathing
      }
    }

    // 3. optional folder notes, so every bubble has a page of its own
    if (o.folderNotes) {
      for (const target of mapDir.values()) {
        try { fileForNode(target); } catch (err) { log.warn('folder note failed for ' + target + ': ', err); }
      }
    }

    vault.clearCache();
    log.info('imported tree ' + plan.name + ': ' + plan.folders.length + ' folders, ' +
      notes + ' notes, ' + parts + ' parts, ' + plan.skipped.length + ' skipped');

    results.push({
      root: finalRel,
      name: rootName,
      folders: plan.folders.length,
      notes, parts, attachments,
      skipped: plan.skipped.concat(failed),
      truncated: plan.truncated
    });
  }

  if (!results.length) return { ok: false, error: 'Nothing there looked like a folder.' };
  return { ok: true, results };
});

// Pick a folder to import as a tree.
handle('pick-folder', async (_e, title) => {
  const r = await dialog.showOpenDialog({
    title: title || 'Choose a folder to import',
    properties: ['openDirectory', 'multiSelections']
  });
  return (r.canceled ? [] : r.filePaths);
});

// Pick arbitrary files (the import dialog is deliberately narrow; this is not).
handle('pick-files', async (_e, title) => {
  const r = await dialog.showOpenDialog({
    title: title || 'Choose files',
    properties: ['openFile', 'multiSelections']
  });
  return (r.canceled ? [] : r.filePaths);
});

// Paste an image straight out of the clipboard into the vault.
handle('import-image-buffer', (_e, bytes, name, folderId) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  if (!bytes || !bytes.byteLength) return { ok: false, error: 'Clipboard had no image.' };
  const attachDir = path.join(settings.vaultPath, vault.ATTACH_DIR);
  fs.mkdirSync(attachDir, { recursive: true });
  const safe = sanitizeName(name || '', 'pasted') || 'pasted';
  const ext = path.extname(safe) || '.png';
  const stem = path.basename(safe, ext) || 'pasted';
  let dest = path.join(attachDir, stem + '-' + Date.now() + ext);
  touched();
  writeFileAtomic(dest, Buffer.from(bytes));
  const rel = path.posix.join(vault.ATTACH_DIR, path.basename(dest));
  const folder = folderId == null ? 'Imported' : folderId;
  const dir = folder ? inVault(folder) : path.resolve(settings.vaultPath);
  fs.mkdirSync(dir, { recursive: true });
  const note = writeNoteFile(dir, 'Pasted image', '![' + path.basename(dest) + '](' + rel + ')\n', folder, null);
  return { ok: true, note, rel };
});

// ---- ephemeral burner notes ----
// A note with an `expires:` field deletes itself once that time passes.
function purgeExpired() {
  if (!settings.vaultPath) return 0;
  let removed = 0;
  const now = Date.now();
  for (const file of vault.walk(settings.vaultPath)) {
    try {
      const { fm } = fmlib.splitFM(fs.readFileSync(file, 'utf8'));
      if (!fm.expires) continue;
      const t = Date.parse(String(fm.expires).replace(/^"|"$/g, ''));
      if (!t || t > now) continue;
      touched();
      fs.rmSync(file, { force: true });
      removed++;
      log.info('burner note expired: ' + relOf(file));
    } catch {}
  }
  if (removed) {
    vault.clearCache();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('vault-changed');
  }
  return removed;
}
handle('purge-expired', () => ({ removed: purgeExpired() }));

handle('set-note-ttl', (_e, relId, hours) => {
  if (!settings.vaultPath) return { ok: false, error: 'No vault selected.' };
  const file = inVault(relId);
  const parts = fmlib.splitFM(fs.readFileSync(file, 'utf8'));
  if (hours == null || hours === 0) {
    delete parts.fm.expires;
    parts.order = parts.order.filter(k => k !== 'expires');
  } else {
    parts.fm.expires = new Date(Date.now() + Number(hours) * 3600000).toISOString();
    if (!parts.order.includes('expires')) parts.order.push('expires');
  }
  touched();
  writeFileAtomic(file, fmlib.joinFM(parts), 'utf8');
  return { ok: true, expires: parts.fm.expires || null };
});

// Does the vault already have notes? Used to skip the splash screen on launch.
handle('vault-has-notes', () => {
  if (!settings.vaultPath) return { hasNotes: false, count: 0 };
  const n = vault.walk(settings.vaultPath).length;
  return { hasNotes: n > 0, count: n };
});

// folders that exist right now (for the re-file picker)
function folderList() {
  if (!settings.vaultPath) return [];
  const out = [];
  const stack = [{ dir: settings.vaultPath, rel: '' }];
  while (stack.length) {
    const { dir, rel } = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === vault.ATTACH_DIR || e.name === 'node_modules') continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      out.push(childRel);
      stack.push({ dir: path.join(dir, e.name), rel: childRel });
    }
  }
  return out.sort();
}
handle('list-folders', () => folderList());

// ---- quick capture window ----
handle('quick-hide', () => { if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide(); return true; });
handle('quick-open-main', (_e, relId) => {
  if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide();
  showMain();
  if (relId && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu-action', 'open-note:' + relId);
  return true;
});

function ensureVaultScaffold() {
  const cfgDir = path.join(settings.vaultPath, '.synapse');
  fs.mkdirSync(cfgDir, { recursive: true });
  const rulesDest = path.join(cfgDir, 'rules.json');
  if (!fs.existsSync(rulesDest)) {
    fs.copyFileSync(path.join(__dirname, 'rules.json'), rulesDest);
  }
}
