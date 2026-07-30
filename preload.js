// preload.js — safe bridge between the renderer (UI) and main (filesystem).
// Every entry is a narrow, task-specific function: no raw ipcRenderer, no Node
// APIs and no channel names reach the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// ---------------------------------------------------------------------------
// File drops
//
// File objects must NEVER cross contextBridge. The bridge clones/proxies its
// arguments, and webUtils.getPathForFile() requires a genuine File backed by a
// real blob — handing it a proxy yields empty paths at best and takes the
// renderer down at worst. The preload shares the page's DOM, so it reads the
// drop here and passes plain strings across instead.
// ---------------------------------------------------------------------------
function pathForFile(file) {
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const p = webUtils.getPathForFile(file);
      if (p) return p;
    }
  } catch {}
  // very old Electron kept the path on the File itself
  return (file && typeof file.path === 'string' && file.path) ? file.path : null;
}

let dropHandler = null;

window.addEventListener('drop', (e) => {
  if (!dropHandler || !e.dataTransfer) return;
  let files = [];
  try { files = Array.from(e.dataTransfer.files || []); } catch { return; }
  if (!files.length) return;

  e.preventDefault();
  const paths = [];
  for (const f of files) {
    const p = pathForFile(f);
    if (p) paths.push(p);
  }
  // plain strings and numbers only — safe to send across the bridge
  try { dropHandler({ paths, x: e.clientX, y: e.clientY, count: files.length }); } catch {}
}, true);

// Chromium would otherwise navigate the window to the dropped file.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1) e.preventDefault();
}, true);

// Wrap a main-process listener so the renderer only ever receives the payload,
// never the IpcRendererEvent (which exposes the sender).
const on = (channel) => (cb) => {
  if (typeof cb !== 'function') return () => {};
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('synapse', {
  // vault + notes
  getVault:       ()             => ipcRenderer.invoke('get-vault'),
  chooseVault:    ()             => ipcRenderer.invoke('choose-vault'),
  scanVault:      ()             => ipcRenderer.invoke('scan-vault'),
  previewThought: (text)         => ipcRenderer.invoke('preview-thought', text),
  captureThought: (text)         => ipcRenderer.invoke('capture-thought', text),
  readNote:       (id)           => ipcRenderer.invoke('read-note', id),
  writeNote:      (id, content)  => ipcRenderer.invoke('write-note', id, content),
  deleteNote:     (id)           => ipcRenderer.invoke('delete-note', id),
  reveal:         (id)           => ipcRenderer.invoke('reveal', id),

  // import
  importFiles:    ()             => ipcRenderer.invoke('import-files'),
  importLink:     (url, note)    => ipcRenderer.invoke('import-link', url, note),
  newAttachmentNote: (md)        => ipcRenderer.invoke('new-attachment-note', md),

  // creation + import
  createNote:     (text, folderId, opts) => ipcRenderer.invoke('create-note', text, folderId, opts),
  importPaths:    (paths, opts)  => ipcRenderer.invoke('import-paths', paths, opts),
  importImageBuffer: (bytes, name, folderId) => ipcRenderer.invoke('import-image-buffer', bytes, name, folderId),
  attachToNote:   (relId, paths, opts) => ipcRenderer.invoke('attach-to-note', relId, paths, opts),
  breakdownFile:  (paths, folderId) => ipcRenderer.invoke('breakdown-file', paths, folderId),
  pickFiles:      (title)        => ipcRenderer.invoke('pick-files', title),
  // Register the one callback that receives dropped file paths.
  onFilesDropped: (cb) => { dropHandler = (typeof cb === 'function') ? cb : null; },

  // folders
  openFolder:     (relId)        => ipcRenderer.invoke('open-folder', relId),
  renameFolder:   (relId, name)  => ipcRenderer.invoke('rename-folder', relId, name),
  mergeFolders:   (from, into)   => ipcRenderer.invoke('merge-folders', from, into),
  deleteFolder:   (relId)        => ipcRenderer.invoke('delete-folder', relId),

  // ephemeral notes
  setNoteTtl:     (relId, hours) => ipcRenderer.invoke('set-note-ttl', relId, hours),
  purgeExpired:   ()             => ipcRenderer.invoke('purge-expired'),
  vaultHasNotes:  ()             => ipcRenderer.invoke('vault-has-notes'),

  // structure
  setParent:      (child, parent)=> ipcRenderer.invoke('set-parent', child, parent),
  addWikilink:    (from, to)     => ipcRenderer.invoke('add-wikilink', from, to),
  createFolder:   (name, parent) => ipcRenderer.invoke('create-folder', name, parent),
  groupNotes:     (ids, name)    => ipcRenderer.invoke('group-notes', ids, name),
  moveNote:       (id, folderId) => ipcRenderer.invoke('move-note', id, folderId),
  listFolders:    ()             => ipcRenderer.invoke('list-folders'),

  // settings / config / rules
  getAppInfo:     ()             => ipcRenderer.invoke('get-app-info'),
  getSettings:    ()             => ipcRenderer.invoke('get-settings'),
  setSettings:    (patch)        => ipcRenderer.invoke('set-settings', patch),
  getConfig:      ()             => ipcRenderer.invoke('get-config'),
  setConfig:      (patch)        => ipcRenderer.invoke('set-config', patch),
  resetConfig:    ()             => ipcRenderer.invoke('reset-config'),
  getRules:       ()             => ipcRenderer.invoke('get-rules'),
  setRules:       (rules)        => ipcRenderer.invoke('set-rules', rules),
  learnFiling:    (text, folder) => ipcRenderer.invoke('learn-filing', text, folder),
  saveImage:      (dataUrl)      => ipcRenderer.invoke('save-image', dataUrl),
  showLog:        ()             => ipcRenderer.invoke('show-log'),
  checkUpdates:   ()             => ipcRenderer.invoke('check-updates'),
  openRelease:    ()             => ipcRenderer.invoke('open-release'),
  installUpdate:  ()             => ipcRenderer.invoke('install-update'),

  // quick capture window
  quickHide:      ()             => ipcRenderer.invoke('quick-hide'),
  quickOpenMain:  (id)           => ipcRenderer.invoke('quick-open-main', id),

  // main -> renderer events
  onUpdateStatus:   on('update-status'),
  onMenuAction:     on('menu-action'),
  onVaultChanged:   on('vault-changed'),
  onShortcutFailed: on('shortcut-failed'),
  onQuickReset:     on('quick-reset')
});
