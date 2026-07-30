// Stub of preload.js for the headless UI smoke test (test/ui-smoke.js).
// Records every call so the test can assert what the UI asked main to do.
const { contextBridge } = require('electron');

const calls = [];
const rec = (name, result) => (...args) => { calls.push({ name, args }); return Promise.resolve(result); };

// the real preload reads dropped files itself and hands back plain paths;
// the test drives that callback directly
let dropCb = null;

contextBridge.exposeInMainWorld('synapse', {
  getVault: rec('getVault', 'C:/tmp/vault'),
  chooseVault: rec('chooseVault', 'C:/tmp/vault'),
  scanVault: rec('scanVault', { nodes: [], links: [], folders: [], suggestions: [] }),
  previewThought: rec('previewThought', { folder: 'Ideas', reason: 'test' }),
  captureThought: rec('captureThought', { id: 'Ideas/x.md', folder: 'Ideas', title: 'X' }),
  readNote: rec('readNote', '---\ntitle: "X"\nfolder: Ideas\ntags: []\n---\nbody'),
  writeNote: rec('writeNote', true),
  deleteNote: rec('deleteNote', { ok: true }),
  reveal: rec('reveal', true),
  importFiles: rec('importFiles', []),
  importLink: rec('importLink', { id: 'Links/x.md', title: 'Saved link' }),
  newAttachmentNote: rec('newAttachmentNote', { id: 'Attachments/x.md', title: 'X' }),
  setParent: rec('setParent', { ok: true }),
  addWikilink: rec('addWikilink', { ok: true }),
  createFolder: rec('createFolder', { id: 'Research', title: 'Research' }),
  groupNotes: rec('groupNotes', { id: 'G', moved: [] }),
  moveNote: rec('moveNote', { ok: true, to: 'Tasks/x.md' }),
  listFolders: rec('listFolders', ['Ideas', 'Tasks', 'Research']),
  createNote: rec('createNote', { id: 'Ideas/spawned.md', title: 'Spawned', folder: 'Ideas', guessed: false }),
  importPaths: rec('importPaths', { ok: true, created: [{ id: 'Imported/a.md', title: 'A' }], skipped: [], folder: 'Imported' }),
  importImageBuffer: rec('importImageBuffer', { ok: true, note: { id: 'Imported/img.md', title: 'Pasted image' }, rel: 'attachments/x.png' }),
  attachToNote: rec('attachToNote', { ok: true, attached: [{ name: 'a.txt', kind: 'text' }], children: [], skipped: [] }),
  breakdownFile: rec('breakdownFile', { ok: true, docs: [{ doc: { id: 'Breakdown/doc.md', title: 'Doc' }, parts: [{ id: 'Breakdown/p1.md' }, { id: 'Breakdown/p2.md' }] }], skipped: [], folder: 'Breakdown' }),
  pickFiles: rec('pickFiles', ['C:/tmp/picked.txt']),
  onFilesDropped: (cb) => { dropCb = (typeof cb === 'function') ? cb : null; },
  openFolder: rec('openFolder', { ok: true, path: 'C:/tmp/vault/Ideas' }),
  renameFolder: rec('renameFolder', { ok: true, id: 'Renamed', title: 'Renamed' }),
  mergeFolders: rec('mergeFolders', { ok: true, moved: [{ from: 'a', to: 'b' }], into: 'Tasks' }),
  deleteFolder: rec('deleteFolder', { ok: true, notes: 3 }),
  setNoteTtl: rec('setNoteTtl', { ok: true, expires: '2030-01-01T00:00:00.000Z' }),
  purgeExpired: rec('purgeExpired', { removed: 0 }),
  vaultHasNotes: rec('vaultHasNotes', { hasNotes: false, count: 0 }),
  getAppInfo: rec('getAppInfo', {
    version: '0.3.1', electron: '31.0.0', logFile: 'C:/tmp/log',
    vaultPath: 'C:/tmp/vault', quickShortcut: 'Control+Shift+Space',
    quickCaptureEnabled: true, runInTray: false
  }),
  getSettings: rec('getSettings', {
    groupCreate: 'both', quickShortcut: 'Control+Shift+Space',
    quickCaptureEnabled: true, runInTray: false
  }),
  setSettings: rec('setSettings', {
    groupCreate: 'both', quickShortcut: 'Control+Shift+Space',
    quickCaptureEnabled: true, runInTray: false
  }),
  getConfig: rec('getConfig', {}),
  setConfig: rec('setConfig', {}),
  resetConfig: rec('resetConfig', {}),
  getRules: rec('getRules', { rules: [] }),
  setRules: rec('setRules', { ok: true }),
  learnFiling: rec('learnFiling', { ok: true, added: ['gateway'] }),
  saveImage: rec('saveImage', { ok: true }),
  showLog: rec('showLog', { ok: true }),
  quickHide: rec('quickHide', true),
  quickOpenMain: rec('quickOpenMain', true),
  onUpdateStatus: () => () => {},
  onMenuAction: () => () => {},
  onVaultChanged: () => () => {},
  onShortcutFailed: () => () => {},
  onQuickReset: () => () => {},

  // test-only introspection
  __calls: () => calls.slice(),
  __reset: () => { calls.length = 0; },
  __hasDropCb: () => typeof dropCb === 'function',
  __fireDrop: (info) => { if (dropCb) dropCb(info); }
});
