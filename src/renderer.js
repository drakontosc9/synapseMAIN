// renderer.js — orchestration: capture, graph, search, palette, settings, panels.
const api = window.synapse;
const el = id => document.getElementById(id);

let graph = null, vaultPath = null, currentNote = null, editing = false, editorDirty = false;
let settings = { groupCreate: 'both' };
let config = {};
let appInfo = {};
let lastScan = null;
let searchExact = false;
let undoStack = [];
let audioCtx = null;

const THEMES = {
  midnight: { '--bg': '#0e1116', '--bg-soft': '#161b22', '--panel': '#1b2129', '--line': '#2a323d', '--text': '#e6edf3', '--muted': '#8b98a5', grid: 'rgba(160,175,195,0.16)', dark: true },
  dusk:     { '--bg': '#14121c', '--bg-soft': '#1d1a2a', '--panel': '#241f34', '--line': '#352e49', '--text': '#ece6f3', '--muted': '#9a90ad', grid: 'rgba(180,165,205,0.16)', dark: true },
  forest:   { '--bg': '#0e1613', '--bg-soft': '#14201b', '--panel': '#182a22', '--line': '#264035', '--text': '#e4f0ea', '--muted': '#87a596', grid: 'rgba(150,200,170,0.14)', dark: true },
  slate:    { '--bg': '#12151a', '--bg-soft': '#1a1f27', '--panel': '#20262f', '--line': '#333c48', '--text': '#e8edf2', '--muted': '#93a0ad', grid: 'rgba(160,175,195,0.15)', dark: true },
  paper:    { '--bg': '#f6f5f1', '--bg-soft': '#eeece5', '--panel': '#ffffff', '--line': '#dcd8ce', '--text': '#242018', '--muted': '#7a7566', grid: 'rgba(60,55,45,0.10)', dark: false },
  contrast: { '--bg': '#000000', '--bg-soft': '#0c0c0c', '--panel': '#111111', '--line': '#333333', '--text': '#ffffff', '--muted': '#aaaaaa', grid: 'rgba(255,255,255,0.14)', dark: true }
};

// ---------- boot ----------
(async function boot() {
  vaultPath = await api.getVault();
  if (!vaultPath) el('noVault').classList.remove('hidden'); else setVaultName();
  try { settings = await api.getSettings() || settings; } catch {}
  try { config = await api.getConfig() || {}; } catch {}

  graph = new SynapseGraph(el('graph'), {
    onNodeClick: openNote,
    onBackgroundClick: () => { closePanel(); hideCtx(); hideSearch(); },
    onPickup: () => showHint('Carrying a note — drop it on another to make it a <b>child</b>. Release on empty space to cancel.'),
    onMakeChild: makeChild, onMakeLink: makeLink,
    onSelectionChange: updateSelbar, onContextMenu: showCtx,
    onBreadcrumb: renderBreadcrumb, onFocusGraph: onFocusGraph,
    onHover: showHoverCard, onHoverEnd: hideHoverCard
  });

  wireCapture(); wireWorkspace(); wireSettings(); wirePalette(); wireAsk();
  applyConfig(config);
  applySettingsToUI();
  if (api.onUpdateStatus) api.onUpdateStatus(d => {
    if (d.state === 'available') toast('Update <b>' + d.version + '</b> found — downloading…');
    else if (d.state === 'downloading' && d.percent % 25 === 0) toast('Downloading update… ' + d.percent + '%');
    else if (d.state === 'ready') toast('Update <b>' + d.version + '</b> ready — restart to install');
  });
  if (api.onMenuAction) api.onMenuAction(handleMenuAction);
  if (api.onVaultChanged) api.onVaultChanged(onVaultChanged);
  if (api.onShortcutFailed) api.onShortcutFailed(msg =>
    toast('Quick-capture hotkey unavailable — ' + escapeHtml(String(msg || '')) ));

  try { appInfo = await api.getAppInfo() || {}; } catch {}
  renderAbout();

  await refresh();
})();

// ---------- main-process events ----------
function handleMenuAction(action) {
  if (typeof action !== 'string') return;
  if (action.startsWith('open-note:')) { openNote({ id: action.slice('open-note:'.length) }); return; }
  switch (action) {
    case 'new-thought':   newThought(); break;
    case 'choose-vault':  pickVault(); break;
    case 'export-png':    doExportPng(); break;
    case 'open-settings': openSettings(); break;
    case 'focus-search':  showWorkspace(true, true); el('search').focus(); el('search').select(); break;
    case 'palette':       openPalette(); break;
    case 'fit':           showWorkspace(true, true); graph.home(); break;
    case 'rescan':        refresh().then(() => toast('Reloaded from disk')); break;
    case 'recents':       toggleRecents(); break;
    case 'cycle-theme':   cycleTheme(); break;
    case 'open-help':     openSettings(); selectSettingsTab('help'); break;
  }
}

// Someone edited the vault in Obsidian / VS Code / Explorer.
let externalTimer = null;
function onVaultChanged() {
  clearTimeout(externalTimer);
  externalTimer = setTimeout(async () => {
    const before = graph.nodes.length;
    await refresh();
    if (!el('recents').classList.contains('hidden')) renderRecents();
    // refresh the open note too, unless the user is mid-edit — their text wins
    if (currentNote && !editorDirty) {
      try {
        const raw = await api.readNote(currentNote.id);
        if (raw !== el('panelEdit').value) { await openNote({ id: currentNote.id }); toast('Reloaded — this note changed on disk'); return; }
      } catch { /* note vanished; the rescan above already dropped it */ }
    }
    if (graph.nodes.length !== before) toast('Vault updated on disk');
  }, 260);
}

function vaultLabel() { return vaultPath ? vaultPath.split(/[\\/]/).filter(Boolean).pop() : 'Vault'; }
function setVaultName() { const e = el('vaultName'); if (e) e.textContent = vaultLabel(); renderBreadcrumb([]); }

// ---------- config / theme ----------
function applyConfig(cfg) {
  config = Object.assign({}, config, cfg);
  const th = THEMES[config.theme] || THEMES.midnight;
  const root = document.documentElement.style;
  for (const k of Object.keys(th)) if (k.startsWith('--')) root.setProperty(k, th[k]);
  root.setProperty('--accent', config.accent || '#7c9cff');
  root.setProperty('--accent-soft', hexA(config.accent || '#7c9cff', th.dark ? .22 : .14));
  if (graph) graph.setConfig({
    background: config.background, gridColor: th.grid, gridSpacing: config.gridSpacing,
    nodeScale: config.nodeScale, labelScale: config.labelScale, folderBase: config.folderBase, folderGrow: config.folderGrow,
    threshold: config.threshold, ramp: config.ramp, repulsion: config.repulsion, spring: config.spring,
    linkTension: config.linkTension, packing: config.packing, animSpeed: config.animSpeed, inertia: config.inertia,
    longPressMs: config.longPressMs, ripples: config.ripples, showMinimap: config.showMinimap,
    showSuggestions: config.showSuggestions, reveal: config.reveal || 'fade',
    edgeStyle: config.edgeStyle || 'curved', folderColors: config.folderColors || {}
  });
  syncControls();
}
async function updateConfig(patch) { config = await api.setConfig(patch); applyConfig(config); }

function hexA(hex, a) {
  const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

// ---------- capture ----------
function wireCapture() {
  const box = el('thought');
  const grow = () => { box.style.height = 'auto'; box.style.height = box.scrollHeight + 'px'; };
  box.addEventListener('input', grow);
  let pv = null;
  box.addEventListener('input', () => { clearTimeout(pv); pv = setTimeout(async () => { const text = box.value.trim(); if (!text) { el('destination').textContent = ''; return; } const p = await api.previewThought(text); el('destination').textContent = p ? '→ ' + p.folder : ''; }, 180); });
  box.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault(); const text = box.value.trim(); if (!text) return;
      if (!vaultPath) { vaultPath = await api.chooseVault(); if (!vaultPath) return; el('noVault').classList.add('hidden'); setVaultName(); }
      let res;
      try { res = await api.captureThought(text); }
      catch (err) { toast((err && err.message) || 'Could not save that thought.'); return; }
      box.value = ''; box.style.height = 'auto'; el('destination').textContent = '';
      await refresh(); showWorkspace(true, true); graph.reheat(1);
      setTimeout(() => { graph.focusNote(res.id); if (config.ripples) graph.rippleNote(res.id); if (config.sound) playTick(); }, 480);
      // filing is a guess, so always offer the correction inline rather than
      // making the user hunt the note down in the graph
      toastAction('Filed in <b>' + escapeHtml(res.folder) + '</b>', 'Wrong folder?', () => refileCapture(res, text));
    }
  });
  el('chooseVault').addEventListener('click', pickVault);
  el('toGraph').addEventListener('click', () => showWorkspace(true));
}

// ---------- workspace ----------
function wireWorkspace() {
  el('backToCapture').addEventListener('click', newThought);
  el('rescan').addEventListener('click', async () => { await refresh(); toast('Reloaded from disk'); });
  el('fitBtn').addEventListener('click', () => graph.home());
  el('exportBtn').addEventListener('click', doExportPng);
  el('recentsBtn').addEventListener('click', toggleRecents);
  el('closeRecents').addEventListener('click', closeRecents);
  el('moveNoteBtn').addEventListener('click', doMoveNote);
  el('deleteNoteBtn').addEventListener('click', () => doDeleteNote());
  el('newGroupBtn').addEventListener('click', () => createGroup(''));
  el('importBtn').addEventListener('click', onImport);
  el('linkBtn').addEventListener('click', onAddLink);
  el('groupSelected').addEventListener('click', doGroupSelected);
  el('clearSel').addEventListener('click', () => { graph.clearSelection(); updateSelbar([]); });
  el('clearFocus').addEventListener('click', () => { graph.clearFocus(); el('focusbar').classList.add('hidden'); });

  // panel
  el('closePanel').addEventListener('click', closePanel);
  el('editToggle').addEventListener('click', () => setEditing(!editing));
  el('cancelEdit').addEventListener('click', () => { setEditing(false); renderNote(); });
  el('revealBtn').addEventListener('click', () => currentNote && api.reveal(currentNote.id));
  el('focusBtn').addEventListener('click', () => { if (currentNote) { graph.setFocus(currentNote.id); onFocusGraph(); } });
  el('saveNote').addEventListener('click', saveCurrentNote);

  // Unsaved edits used to vanish silently when the panel closed or another note
  // was opened. Track dirtiness and flush on blur / close / switch instead.
  el('panelEdit').addEventListener('input', () => markDirty(true));
  el('panelEdit').addEventListener('blur', () => { flushEditor(); });

  // [[wikilinks]] in the preview are now navigable
  el('panelView').addEventListener('click', e => {
    const w = e.target.closest('.wikilink');
    if (w) { e.preventDefault(); openByTitle(w.dataset.wiki); }
  });

  // search
  wireSearch();

  // global keys
  window.addEventListener('keydown', onGlobalKey);
  window.addEventListener('mouseup', () => setTimeout(hideHint, 60));
  window.addEventListener('click', e => { if (!el('ctxmenu').contains(e.target)) hideCtx(); if (!el('search').contains(e.target) && !el('searchResults').contains(e.target)) hideSearch(); });
}

// Text fields own their native shortcuts (undo, select-all, caret motion).
// Intercepting them globally is what made Ctrl+Z clobber edits in the note editor.
function inTextField(e) {
  const t = e.target;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function onGlobalKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  const key = (e.key || '').toLowerCase();

  if (e.key === 'Escape') {
    if (askOpen()) { finishAsk(null); return; }
    if (!el('settingsModal').classList.contains('hidden')) { closeSettings(); return; }
    if (!el('palette').classList.contains('hidden')) { closePalette(); return; }
    hideSearch(); hideCtx();
    return;
  }
  if (askOpen()) return;          // the dialog handles its own keys

  if (mod && key === 'k') { e.preventDefault(); openPalette(); return; }
  if (mod && key === 'z') {
    if (inTextField(e)) return;    // let the field undo its own text
    e.preventDefault(); doUndo(); return;
  }
  if (mod && key === 's') {
    if (editing && currentNote) { e.preventDefault(); saveCurrentNote(); }
    return;
  }
  if (mod && key === 'f') {
    e.preventDefault(); showWorkspace(true, true); el('search').focus(); el('search').select(); return;
  }
  if (mod && key === 'n') { e.preventDefault(); newThought(); return; }
  if (mod && e.key === 'Enter') {
    if (editing && currentNote) { e.preventDefault(); saveCurrentNote(); }
    return;
  }
}

function newThought() { showWorkspace(false); el('thought').focus(); }

function showWorkspace(on, skipFit) {
  el('workspace').classList.toggle('hidden', !on);
  el('capture').classList.toggle('hidden', on);
  if (on) { graph.reheat(.5); if (!skipFit) setTimeout(() => graph.fit(), 300); }
}
function applySettingsToUI() {
  const mode = settings.groupCreate || 'both';
  const r = document.querySelector('input[name="groupCreate"][value="' + mode + '"]'); if (r) r.checked = true;
  el('newGroupBtn').style.display = (mode === 'empty' || mode === 'both') ? '' : 'none';
  el('quickShortcut').value = settings.quickShortcut || 'Control+Shift+Space';
  el('quickCaptureEnabled').checked = settings.quickCaptureEnabled !== false;
  el('runInTray').checked = !!settings.runInTray;
}

function selectSettingsTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('hidden', p.dataset.page !== name));
}

function renderAbout() {
  const box = el('aboutBox'); if (!box) return;
  box.innerHTML =
    '<b>Synapse ' + escapeHtml(appInfo.version || '?') + '</b><br>' +
    'Electron ' + escapeHtml(appInfo.electron || '?') + '<br>' +
    'Vault: ' + escapeHtml(appInfo.vaultPath || 'none chosen') + '<br>' +
    'Log: ' + escapeHtml(appInfo.logFile || 'unavailable');
}

// ---------- data ----------
async function refresh() { const data = await api.scanVault(); lastScan = data; graph.setData(data); buildLegend(); }
function buildLegend() {
  const legend = el('legend'); legend.innerHTML = '';
  const et = new Set(['wikilink', 'tag', 'parent']);
  const mk = (type, label, style) => { const r = document.createElement('div'); r.className = 'legend-row'; r.innerHTML = '<span style="width:16px;border-top:' + style + '"></span><span>' + label + '</span>'; r.onclick = () => { if (et.has(type)) et.delete(type); else et.add(type); r.classList.toggle('off'); graph.setEdgeTypes(new Set(et)); }; return r; };
  legend.appendChild(mk('parent', 'parent → child', '2px solid rgba(240,163,94,.85)'));
  legend.appendChild(mk('wikilink', '[[wikilinks]]', '2px solid rgba(160,175,195,.8)'));
  legend.appendChild(mk('tag', 'shared #tags', '2px dotted rgba(124,156,255,.7)'));
  const tip = document.createElement('div'); tip.className = 'legend-edges'; tip.textContent = 'Click a folder to zoom in · double-click a note to focus'; legend.appendChild(tip);

  // Tags on hundreds of notes say nothing about any specific pair, so their
  // edges are skipped. Say so, rather than leaving the user to wonder.
  const busy = (lastScan && lastScan.busyTags) || [];
  if (busy.length) {
    const b = document.createElement('div');
    b.className = 'legend-edges';
    b.title = busy.map(t => '#' + t.tag + ' (' + t.count + ' notes)').join('\n');
    b.textContent = busy.length === 1
      ? '#' + busy[0].tag + ' is on ' + busy[0].count + ' notes — too common to draw'
      : busy.length + ' tags too common to draw';
    legend.appendChild(b);
  }
}

// ---------- search dropdown ----------
function wireSearch() {
  const inp = el('search');
  inp.addEventListener('input', runSearch);
  inp.addEventListener('focus', () => { if (inp.value.trim()) runSearch(); });
}
function runSearch() {
  const q = el('search').value; graph.setSearch(q);
  const box = el('searchResults');
  if (!q.trim()) { hideSearch(); return; }
  const results = SynapseSearch.searchNotes(q, graph.nodes, { exact: searchExact });
  box.innerHTML = '';
  const mode = document.createElement('div'); mode.className = 'sr-mode';
  mode.innerHTML = '<span class="muted">' + results.length + ' result' + (results.length === 1 ? '' : 's') + '</span>' +
    '<label><input type="checkbox" id="srExact" ' + (searchExact ? 'checked' : '') + '> exact only</label>';
  box.appendChild(mode);
  mode.querySelector('#srExact').addEventListener('change', e => { searchExact = e.target.checked; runSearch(); });
  if (!results.length) { const e = document.createElement('div'); e.className = 'sr-empty'; e.textContent = 'No matches'; box.appendChild(e); box.classList.remove('hidden'); return; }
  // tree: group by folder
  const groups = {};
  for (const r of results) { (groups[r.node.folder] = groups[r.node.folder] || []).push(r); }
  for (const folder of Object.keys(groups)) {
    const h = document.createElement('div'); h.className = 'sr-folder'; h.textContent = folder; box.appendChild(h);
    for (const r of groups[folder]) {
      const it = document.createElement('div'); it.className = 'sr-item';
      it.innerHTML = '<span class="sr-dot" style="background:' + graph.colorFor(r.node.folder) + '"></span><span class="sr-title">' + escapeHtml(r.node.title) + '</span>' + (searchExact ? '' : '<span class="sr-score">' + r.score.toFixed(0) + '</span>');
      it.addEventListener('mouseenter', () => graph.focusNote(r.node.id));   // pan/reveal on hover
      it.addEventListener('click', () => { hideSearch(); openNote(r.node); });
      box.appendChild(it);
    }
  }
  box.classList.remove('hidden');
}
function hideSearch() { el('searchResults').classList.add('hidden'); }

// ---------- actions ----------
async function makeChild(childId, parentId) {
  hideHint(); const child = graph.map.get(childId), parent = graph.map.get(parentId);
  if (!parent || parent.type !== 'note') { toast('Drop onto a <b>note</b> to set its parent.'); return; }
  const res = await api.setParent(childId, parentId);
  if (!res.ok) { toast(res.reason || 'Could not link.'); return; }
  pushUndo('parent of ' + short(child.title), async () => { await api.setParent(childId, res.prev); await refresh(); });
  await refresh(); toast('<b>' + short(child.title) + '</b> is now a child of <b>' + short(parent.title) + '</b>');
}
async function makeLink(fromId, toId) {
  const a = graph.map.get(fromId), b = graph.map.get(toId);
  const res = await api.addWikilink(fromId, toId); await refresh();
  toast(res.already ? 'Already linked' : 'Linked <b>' + short(a.title) + '</b> → <b>' + short(b.title) + '</b>');
}
async function createGroup(parentDir) {
  const name = await askText({
    title: 'New group',
    hint: parentDir ? 'Created inside ' + parentDir : 'Created at the top level of your vault.',
    label: 'Group name', placeholder: 'e.g. Research'
  });
  if (!name) return;
  const r = await api.createFolder(name, parentDir || '');
  if (!r || r.error) { toast(r && r.error ? r.error : 'Could not create that group.'); return; }
  await refresh(); toast('Created group <b>' + short(r.title) + '</b>');
}
async function doGroupSelected() {
  const ids = graph.getSelection().filter(id => { const n = graph.map.get(id); return n && n.type === 'note'; });
  if (!ids.length) { toast('Shift-click some notes first.'); return; }
  const name = await askText({
    title: 'Group ' + ids.length + ' note' + (ids.length === 1 ? '' : 's'),
    hint: 'The notes are moved into this folder on disk.',
    label: 'New folder name', placeholder: 'e.g. Thesis'
  });
  if (!name) return;
  const r = await api.groupNotes(ids, name);
  if (!r || r.error) { toast(r && r.error ? r.error : 'Could not group those notes.'); return; }
  pushUndo('grouping', async () => { for (const m of (r.moved || [])) await api.moveNote(m.to, m.from.includes('/') ? m.from.slice(0, m.from.lastIndexOf('/')) : ''); await refresh(); });
  graph.clearSelection(); updateSelbar([]); await refresh(); toast('Grouped ' + ids.length + ' note(s) into <b>' + short(name) + '</b>');
}
async function pickVault() {
  vaultPath = await api.chooseVault();
  if (!vaultPath) return;
  el('noVault').classList.add('hidden');
  setVaultName();
  config = await api.getConfig(); applyConfig(config);
  await refresh();
}

async function doExportPng() {
  const r = await api.saveImage(graph.exportPNG());
  if (r && r.ok) toast('Exported PNG');
  else if (r && r.error) toast(r.error);
}

// Correct a filing decision, and optionally teach the rules from it. This is
// the loop that makes auto-filing get better instead of just being wrong twice.
async function refileCapture(res, text) {
  const folders = await api.listFolders();
  const r = await askForm({
    title: 'Where should this have gone?',
    hint: '"' + short(res.title) + '" was filed in ' + res.folder + '.',
    okLabel: 'Move it',
    fields: [
      { key: 'folder', label: 'Correct folder', options: folderOptions(folders), value: '' },
      { key: 'learn', label: 'Next time', value: 'yes', options: [
        { value: 'yes', label: 'Remember this for similar thoughts' },
        { value: 'no', label: 'Just move this one' }
      ] }
    ],
    validate: v => (v.folder === res.folder ? 'That is where it already is.' : null)
  });
  if (!r) return;

  const mv = await api.moveNote(res.id, r.folder);
  if (!mv || !mv.ok) { toast((mv && mv.error) || 'Could not move that note.'); return; }

  let learned = null;
  if (r.learn === 'yes' && r.folder) {
    const l = await api.learnFiling(text, r.folder);
    if (l && l.ok) learned = l.added;
  }
  await refresh();
  graph.focusNote(mv.to);
  const where = short(r.folder || 'Inbox');
  toast('Moved to <b>' + where + '</b>' +
    (learned && learned.length ? ' · learned <b>' + learned.map(escapeHtml).join('</b>, <b>') + '</b>' : ''));
}

async function onImport() {
  const files = await api.importFiles(); if (!files.length) return;
  const block = files.map(f => f.markdown).join('\n\n');
  if (editing) { const ta = el('panelEdit'); ta.value += (ta.value.endsWith('\n') ? '' : '\n\n') + block + '\n'; toast('Inserted ' + files.length + ' attachment(s)'); }
  else { const r = await api.newAttachmentNote(block); await refresh(); toast('Imported ' + files.length + ' file(s) → <b>' + short(r.title) + '</b>'); openNote({ id: r.id }); }
}
async function onAddLink() {
  const r = await askForm({
    title: 'Save a link',
    hint: 'Stored as its own note in Links/.',
    okLabel: 'Save link',
    fields: [
      { key: 'url', label: 'URL', placeholder: 'https://…' },
      { key: 'note', label: 'Note (optional)', placeholder: 'Why is this worth keeping?', multiline: true }
    ],
    validate: v => /^https?:\/\/.+/i.test(v.url.trim()) ? null : 'Enter a URL starting with http:// or https://'
  });
  if (!r) return;
  const saved = await api.importLink(r.url.trim(), r.note);
  if (!saved || saved.error) { toast(saved && saved.error ? saved.error : 'Could not save that link.'); return; }
  await refresh(); toast('Saved link → <b>' + short(saved.title) + '</b>');
  openNote({ id: saved.id });
}

// ---------- undo ----------
function pushUndo(label, fn) { undoStack.push({ label, fn }); if (undoStack.length > 40) undoStack.shift(); }
async function doUndo() { const a = undoStack.pop(); if (!a) { toast('Nothing to undo'); return; } await a.fn(); toast('Undid ' + a.label); }

// ---------- selection / focus ----------
function updateSelbar(ids) {
  const notes = (ids || []).filter(id => { const n = graph.map.get(id); return n && n.type === 'note'; });
  const canGroup = settings.groupCreate === 'selection' || settings.groupCreate === 'both';
  if (notes.length && canGroup) { el('selbar').classList.remove('hidden'); el('selcount').textContent = notes.length + ' selected'; } else el('selbar').classList.add('hidden');
}
function onFocusGraph() { el('focusbar').classList.remove('hidden'); }

// ---------- context menu ----------
function showCtx({ x, y, node }) {
  const m = el('ctxmenu'); m.innerHTML = ''; const mode = settings.groupCreate || 'both'; const canEmpty = mode === 'empty' || mode === 'both';
  const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { hideCtx(); fn(); }; m.appendChild(b); };
  if (node && node.type === 'note') {
    add('Open', () => openNote(node));
    add('Focus neighborhood', () => { graph.setFocus(node.id); onFocusGraph(); });
    add('Move to folder…', async () => { await openNote(node); doMoveNote(); });
    add('Clear parent', async () => { await api.setParent(node.id, null); await refresh(); toast('Parent cleared'); });
    add('Reveal file', () => api.reveal(node.id));
    add('Delete note…', () => doDeleteNote(node));
  } else if (node && node.type === 'folder') { add('Zoom into folder', () => graph._zoomToNode(node)); if (canEmpty) add('New group inside', () => createGroup(node.id)); }
  else { if (canEmpty) add('New group', () => createGroup('')); add('Recent notes', openRecents); add('Fit to view', () => graph.home()); }
  if (!m.children.length) return; m.style.left = x + 'px'; m.style.top = y + 'px'; m.classList.remove('hidden');
}
function hideCtx() { el('ctxmenu').classList.add('hidden'); }

// ---------- ask dialog ----------
// Electron deliberately does not implement window.prompt(), so every input we
// need goes through this modal. askForm resolves to a {key: value} map, or null
// if the user cancelled.
let askResolve = null, askValidate = null;

function askOpen() { return !el('askModal').classList.contains('hidden'); }

function askForm({ title, hint, fields, okLabel, validate, danger }) {
  return new Promise(resolve => {
    if (askResolve) finishAsk(null);          // never stack dialogs
    askResolve = resolve; askValidate = validate || null;
    el('askTitle').textContent = title || 'Enter a value';
    const okBtn = el('askOk');
    okBtn.textContent = okLabel || 'OK';
    okBtn.classList.toggle('danger', !!danger);
    const h = el('askHint'); h.textContent = hint || ''; h.classList.toggle('hidden', !hint);
    el('askError').classList.add('hidden');

    const box = el('askFields'); box.innerHTML = '';
    for (const f of (fields || [])) {
      const wrap = document.createElement('label'); wrap.className = 'ask-field';
      if (f.label) { const s = document.createElement('span'); s.textContent = f.label; wrap.appendChild(s); }
      let inp;
      if (f.options) {
        inp = document.createElement('select');
        for (const o of f.options) {
          const op = document.createElement('option');
          op.value = o.value; op.textContent = o.label;
          if (o.value === (f.value || '')) op.selected = true;
          inp.appendChild(op);
        }
      } else {
        inp = document.createElement(f.multiline ? 'textarea' : 'input');
        inp.value = f.value || ''; inp.placeholder = f.placeholder || '';
        inp.setAttribute('autocomplete', 'off'); inp.setAttribute('spellcheck', 'false');
        if (f.multiline) inp.rows = 3;
      }
      inp.className = 'ask-input'; inp.dataset.key = f.key;
      wrap.appendChild(inp); box.appendChild(wrap);
    }
    el('askModal').classList.remove('hidden');
    const first = box.querySelector('.ask-input');
    if (first) { first.focus(); if (first.select) first.select(); } else okBtn.focus();
  });
}

// A dialog with no fields is a confirmation.
async function askConfirm(opts) { return !!(await askForm(Object.assign({ fields: [] }, opts))); }

async function askText(opts) {
  const r = await askForm(Object.assign({}, opts, {
    fields: [{ key: 'value', label: opts.label || '', placeholder: opts.placeholder || '', value: opts.value || '' }],
    validate: opts.validate || (v => v.value.trim() ? null : 'Please enter a name.')
  }));
  return r ? r.value.trim() : null;
}

function askValues() {
  const out = {};
  el('askFields').querySelectorAll('.ask-input').forEach(i => { out[i.dataset.key] = i.value; });
  return out;
}
function askSubmit() {
  const vals = askValues();
  if (askValidate) {
    const err = askValidate(vals);
    if (err) { const e = el('askError'); e.textContent = err; e.classList.remove('hidden'); return; }
  }
  finishAsk(vals);
}
function finishAsk(val) {
  el('askModal').classList.add('hidden');
  const r = askResolve; askResolve = null; askValidate = null;
  if (r) r(val);
}
function wireAsk() {
  el('askOk').addEventListener('click', askSubmit);
  el('askCancel').addEventListener('click', () => finishAsk(null));
  el('askClose').addEventListener('click', () => finishAsk(null));
  el('askModal').addEventListener('click', e => { if (e.target === el('askModal')) finishAsk(null); });
  // listener sits on the modal, not the field list, so zero-field confirmations
  // still respond to Enter and Escape
  el('askModal').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishAsk(null); return; }
    if (e.key !== 'Enter') return;
    // Enter submits, except inside a textarea where it should insert a newline
    if (e.target.tagName === 'TEXTAREA' && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault(); askSubmit();
  });
}

// ---------- hint / hover card ----------
function showHint(html) { const h = el('hint'); h.innerHTML = html; h.classList.remove('hidden'); }
function hideHint() { el('hint').classList.add('hidden'); }
async function showHoverCard(node, x, y) {
  const c = el('hovercard');
  let img = ''; const m = (node.excerpt || '').match(/!\[[^\]]*\]\(([^)]+)\)/);
  c.innerHTML = '<h4>' + escapeHtml(node.title) + '</h4><div class="hc-ex">' + escapeHtml((node.excerpt || '').slice(0, 140)) + '</div>';
  c.style.left = Math.min(x + 16, window.innerWidth - 280) + 'px'; c.style.top = (y + 16) + 'px'; c.classList.remove('hidden');
}
function hideHoverCard() { el('hovercard').classList.add('hidden'); }

// ---------- breadcrumb ----------
function renderBreadcrumb(path) {
  const bc = el('breadcrumb'); bc.innerHTML = '';
  const home = document.createElement('a'); home.className = 'home'; home.textContent = vaultLabel(); home.onclick = () => graph.home(); bc.appendChild(home);
  for (const seg of (path || [])) {
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = ' ▸ '; bc.appendChild(sep);
    const a = document.createElement('a'); a.textContent = seg.title; a.onclick = () => { const n = graph.map.get(seg.id); if (n) n.type === 'folder' ? graph._zoomToNode(n) : openNote(n); }; bc.appendChild(a);
  }
}

// ---------- note panel ----------
async function openNote(node) {
  // switching notes must not discard in-progress edits
  if (currentNote && currentNote.id !== node.id && editorDirty) {
    const prev = short(currentNote.title || currentNote.id);
    if (await flushEditor()) { toast('Saved changes to <b>' + prev + '</b>'); await refresh(); }
  }
  showWorkspace(true, true);
  let raw;
  try { raw = await api.readNote(node.id); }
  catch (err) {
    toast('Could not open that note — it may have been moved or deleted.');
    await refresh();
    return;
  }
  const fm = parseFrontmatter(raw);
  currentNote = { id: node.id, ...fm }; graph.opened = node.id; graph.focusNote(node.id);
  el('panel').classList.remove('hidden');
  el('panelFolder').textContent = fm.folder || 'Inbox';
  el('panelTitle').textContent = fm.title || node.id;
  el('panelTags').innerHTML = (fm.tags || []).map(t => '<span class="tag">#' + escapeHtml(t) + '</span>').join('');
  el('panelEdit').value = raw; markDirty(false); setEditing(false); renderNote();
  renderBacklinks(node.id); renderSuggestions(node.id);
}
function renderNote() { el('panelView').innerHTML = mdToHtml(currentNote.body || ''); }
function setEditing(on) { editing = on; el('panelView').classList.toggle('hidden', on); el('panelEdit').classList.toggle('hidden', !on); el('panelEditBar').classList.toggle('hidden', !on); el('editToggle').textContent = on ? 'Preview' : 'Edit'; if (on) el('panelEdit').focus(); }

async function closePanel() {
  if (editorDirty && await flushEditor()) { toast('Saved changes'); await refresh(); }
  el('panel').classList.add('hidden');
  currentNote = null; graph.opened = null; markDirty(false); setEditing(false);
}

// ---------- editor dirty state ----------
function markDirty(on) {
  editorDirty = !!on;
  const d = el('panelDirty'); if (d) d.classList.toggle('hidden', !editorDirty);
}
// Write the textarea back to disk if it has unsaved changes. Returns true if it wrote.
async function flushEditor() {
  if (!editorDirty || !currentNote) return false;
  try {
    await api.writeNote(currentNote.id, el('panelEdit').value);
    markDirty(false);
    return true;
  } catch (err) {
    toast('Could not save — see the log for details.');
    return false;
  }
}
async function saveCurrentNote() {
  if (!currentNote) return;
  const id = currentNote.id;
  try { await api.writeNote(id, el('panelEdit').value); }
  catch (err) { toast('Could not save that note.'); return; }
  markDirty(false); setEditing(false);
  await refresh(); await openNote({ id }); toast('Saved');
}

// ---------- note actions: move / delete ----------
function folderOptions(folders, includeRoot) {
  const opts = (folders || []).map(f => ({ value: f, label: f }));
  if (includeRoot !== false) opts.unshift({ value: '', label: 'Vault root (Inbox)' });
  return opts;
}
function parentDirOf(id) { return id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''; }

async function doMoveNote() {
  if (!currentNote) return;
  const id = currentNote.id, from = parentDirOf(id);
  const title = short(currentNote.title || id);
  const folders = await api.listFolders();
  const r = await askForm({
    title: 'Move "' + title + '"',
    hint: 'Moves the Markdown file on disk.',
    okLabel: 'Move',
    fields: [{ key: 'folder', label: 'Destination folder', options: folderOptions(folders), value: from }]
  });
  if (!r || r.folder === from) return;
  const res = await api.moveNote(id, r.folder);
  if (!res || !res.ok) { toast((res && res.error) || 'Could not move that note.'); return; }
  pushUndo('move of ' + title, async () => { await api.moveNote(res.to, from); await refresh(); });
  await refresh(); await openNote({ id: res.to });
  toast('Moved to <b>' + short(r.folder || 'Inbox') + '</b>');
}

async function doDeleteNote(node) {
  const target = node || currentNote;
  if (!target) return;
  const title = short(target.title || target.id);
  const yes = await askConfirm({
    title: 'Delete "' + title + '"?',
    hint: 'The file goes to your system trash, so you can still restore it from there.',
    okLabel: 'Move to trash', danger: true
  });
  if (!yes) return;
  try { await api.deleteNote(target.id); }
  catch (err) { toast('Could not delete that note.'); return; }
  if (currentNote && currentNote.id === target.id) {
    markDirty(false);
    el('panel').classList.add('hidden'); currentNote = null; graph.opened = null;
  }
  await refresh();
  toast('Moved <b>' + title + '</b> to the trash');
}

// ---------- recents ----------
// The graph is a beautiful map and a poor index. Most of the time you want the
// thing you wrote twenty minutes ago.
function openRecents() { showWorkspace(true, true); renderRecents(); el('recents').classList.remove('hidden'); }
function closeRecents() { el('recents').classList.add('hidden'); }
function toggleRecents() { el('recents').classList.contains('hidden') ? openRecents() : closeRecents(); }

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function bucketFor(ts, now) {
  if (!ts) return 'Undated';
  const today = startOfDay(now);
  const day = 86400000;
  if (ts >= today) return 'Today';
  if (ts >= today - day) return 'Yesterday';
  if (ts >= today - 6 * day) return 'Earlier this week';
  if (ts >= today - 29 * day) return 'This month';
  return 'Older';
}
function relTime(ts, now) {
  if (!ts) return '';
  const mins = Math.floor((now - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function renderRecents() {
  const box = el('recentsList'); box.innerHTML = '';
  const now = Date.now();
  const rows = graph.nodes
    .filter(n => n.type === 'note')
    .map(n => ({ n, t: Date.parse(n.created || '') || 0 }))
    .sort((a, b) => b.t - a.t)
    .slice(0, 120);

  if (!rows.length) {
    const e = document.createElement('div'); e.className = 'rc-empty';
    e.textContent = 'No notes yet — capture a thought and it will show up here.';
    box.appendChild(e); return;
  }
  let bucket = null;
  for (const { n, t } of rows) {
    const b = bucketFor(t, now);
    if (b !== bucket) {
      bucket = b;
      const h = document.createElement('div'); h.className = 'rc-bucket'; h.textContent = b;
      box.appendChild(h);
    }
    const row = document.createElement('div'); row.className = 'rc-item';
    row.innerHTML = '<span class="sr-dot" style="background:' + graph.colorFor(n.folder) + '"></span>' +
      '<span class="rc-title">' + escapeHtml(n.title) + '</span>' +
      '<span class="rc-meta">' + escapeHtml(relTime(t, now)) + '</span>';
    row.addEventListener('mouseenter', () => graph.focusNote(n.id));
    row.addEventListener('click', () => openNote(n));
    box.appendChild(row);
  }
}

// Resolve a [[wikilink]] title to a note and open it.
function openByTitle(name) {
  const want = String(name).split('|')[0].trim().toLowerCase();
  const hit = graph.nodes.find(n => n.type === 'note' &&
    (String(n.title).toLowerCase() === want || n.id.toLowerCase().replace(/\.md$/, '').split('/').pop() === want));
  if (hit) openNote(hit);
  else toast('No note named <b>' + short(name) + '</b> yet.');
}

function renderBacklinks(id) {
  const box = el('panelBacklinks'); const back = [];
  for (const l of graph.links) { if (l.type === 'tag') continue; if (l.target.id === id) back.push({ node: l.source, rel: l.type === 'parent' ? 'parent' : 'links here' }); if (l.source.id === id && l.type === 'wikilink') back.push({ node: l.target, rel: 'links to' }); }
  if (!back.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h4>Connections</h4>';
  for (const b of back) { const row = document.createElement('div'); row.className = 'link-row'; row.innerHTML = '<span class="sr-dot" style="background:' + graph.colorFor(b.node.folder) + '"></span><span class="lr-title">' + escapeHtml(b.node.title) + '</span><span class="muted" style="font-size:11px">' + b.rel + '</span>'; row.querySelector('.lr-title').onclick = () => openNote(b.node); box.appendChild(row); }
}
function renderSuggestions(id) {
  const box = el('panelSuggest'); const sugg = [];
  for (const s of graph.suggestions) { if (s.a === id || s.b === id) { const other = graph.map.get(s.a === id ? s.b : s.a); if (other) sugg.push({ node: other, shared: s.shared }); } }
  sugg.sort((a, b) => b.shared - a.shared);
  if (!sugg.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h4>Suggested connections</h4>';
  for (const s of sugg.slice(0, 6)) {
    const row = document.createElement('div'); row.className = 'link-row';
    row.innerHTML = '<span class="sr-dot" style="background:' + graph.colorFor(s.node.folder) + '"></span><span class="lr-title">' + escapeHtml(s.node.title) + '</span><button class="ghost small">Link</button>';
    row.querySelector('.lr-title').onclick = () => openNote(s.node);
    row.querySelector('button').onclick = async () => { await api.addWikilink(id, s.node.id); await refresh(); openNote({ id }); toast('Linked'); };
    box.appendChild(row);
  }
}

// ---------- command palette ----------
let palItems = [], palIdx = 0;
function wirePalette() {
  const inp = el('paletteInput');
  inp.addEventListener('input', renderPalette);
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { palIdx = Math.min(palIdx + 1, palItems.length - 1); highlightPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palIdx = Math.max(palIdx - 1, 0); highlightPalette(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (palItems[palIdx]) palItems[palIdx].run(); }
    else if (e.key === 'Escape') closePalette();
  });
}
function openPalette() { el('palette').classList.remove('hidden'); el('paletteInput').value = ''; el('paletteInput').focus(); renderPalette(); }
function closePalette() { el('palette').classList.add('hidden'); }
function renderPalette() {
  const q = el('paletteInput').value.toLowerCase().trim();
  const cmds = [
    { kind: 'action', label: 'New thought', run: () => { closePalette(); newThought(); } },
    { kind: 'action', label: 'Fit / Home', run: () => { closePalette(); graph.home(); } },
    { kind: 'action', label: 'Recent notes', run: () => { closePalette(); openRecents(); } },
    { kind: 'action', label: 'New group', run: () => { closePalette(); createGroup(''); } },
    { kind: 'action', label: 'Save a link', run: () => { closePalette(); onAddLink(); } },
    { kind: 'action', label: 'Move this note to another folder', run: () => { closePalette(); doMoveNote(); } },
    { kind: 'action', label: 'Delete this note', run: () => { closePalette(); doDeleteNote(); } },
    { kind: 'action', label: 'Reload vault from disk', run: async () => { closePalette(); await refresh(); toast('Reloaded from disk'); } },
    { kind: 'action', label: 'Export graph as PNG', run: () => { closePalette(); doExportPng(); } },
    { kind: 'action', label: 'Cycle theme', run: () => { closePalette(); cycleTheme(); } },
    { kind: 'action', label: 'Open settings', run: () => { closePalette(); openSettings(); } },
    { kind: 'action', label: 'Undo last change', run: () => { closePalette(); doUndo(); } }
  ];
  let items = cmds.filter(c => !q || c.label.toLowerCase().includes(q));
  if (q) {
    for (const r of SynapseSearch.searchNotes(q, graph.nodes, { exact: false }).slice(0, 8))
      items.push({ kind: 'note', label: r.node.title, run: () => { closePalette(); openNote(r.node); } });
  }
  palItems = items; palIdx = 0;
  const list = el('paletteList'); list.innerHTML = '';
  items.forEach((it, i) => { const d = document.createElement('div'); d.className = 'palette-item' + (i === 0 ? ' active' : ''); d.innerHTML = escapeHtml(it.label) + '<span class="pi-kind">' + it.kind + '</span>'; d.onclick = it.run; d.onmouseenter = () => { palIdx = i; highlightPalette(); }; list.appendChild(d); });
}
function highlightPalette() { [...el('paletteList').children].forEach((c, i) => c.classList.toggle('active', i === palIdx)); }
function cycleTheme() { const names = Object.keys(THEMES); const i = names.indexOf(config.theme); updateConfig({ theme: names[(i + 1) % names.length] }); toast('Theme: ' + config.theme); }

// ---------- settings ----------
function openSettings() { el('settingsModal').classList.remove('hidden'); loadRulesEditor(); }
function closeSettings() { el('settingsModal').classList.add('hidden'); }
function wireSettings() {
  el('settingsBtn').addEventListener('click', openSettings);
  el('closeSettings').addEventListener('click', closeSettings);
  el('settingsModal').addEventListener('click', e => { if (e.target === el('settingsModal')) closeSettings(); });
  el('resetConfig').addEventListener('click', async () => { config = await api.resetConfig(); applyConfig(config); toast('Reset to defaults'); });

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => selectSettingsTab(t.dataset.tab)));

  // quick capture / tray
  el('applyShortcut').addEventListener('click', applyShortcut);
  el('quickCaptureEnabled').addEventListener('change', applyShortcut);
  el('quickShortcut').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyShortcut(); } });
  el('runInTray').addEventListener('change', async e => {
    settings = Object.assign(settings, await api.setSettings({ runInTray: e.target.checked }));
    toast(e.target.checked ? 'Synapse will stay in the tray when closed' : 'Closing the window will quit Synapse');
  });
  el('openLogBtn').addEventListener('click', async () => {
    const r = await api.showLog();
    if (!r || !r.ok) toast('No log file yet.');
  });

  // theme chips
  const tr = el('themeRow');
  Object.keys(THEMES).forEach(name => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = name; b.dataset.theme = name; b.onclick = () => updateConfig({ theme: name }); tr.appendChild(b); });
  el('accent').addEventListener('input', e => updateConfig({ accent: e.target.value }));
  document.querySelectorAll('#bgRow .chip').forEach(b => b.addEventListener('click', () => updateConfig({ background: b.dataset.bg })));

  const bindToggle = (id, key) => el(id).addEventListener('change', e => updateConfig({ [key]: e.target.checked }));
  ['ripples', 'sound', 'showMinimap', 'showSuggestions', 'inertia'].forEach(k => bindToggle(k, k));
  el('stagger').addEventListener('change', e => updateConfig({ reveal: e.target.checked ? 'stagger' : 'fade' }));
  el('curvedEdges').addEventListener('change', e => updateConfig({ edgeStyle: e.target.checked ? 'curved' : 'straight' }));
  const bindRange = (id, key, fmt) => { el(id).addEventListener('input', e => { const v = parseFloat(e.target.value); el(id + 'V') && (el(id + 'V').textContent = fmt ? fmt(v) : v); updateConfig({ [key]: v }); }); };
  bindRange('nodeScale', 'nodeScale'); bindRange('labelScale', 'labelScale'); bindRange('threshold', 'threshold');
  bindRange('repulsion', 'repulsion'); bindRange('linkTension', 'linkTension'); bindRange('packing', 'packing');
  bindRange('animSpeed', 'animSpeed'); bindRange('longPressMs', 'longPressMs', v => (v / 1000).toFixed(1));

  document.querySelectorAll('input[name="groupCreate"]').forEach(r => r.addEventListener('change', async () => { settings.groupCreate = r.value; await api.setSettings({ groupCreate: r.value }); applySettingsToUI(); }));

  // rules editor
  el('rulesPreviewInput').addEventListener('input', async e => { const t = e.target.value.trim(); el('rulesPreviewOut').textContent = t ? '…' : ''; if (!t) return; const p = await api.previewThought(t); el('rulesPreviewOut').innerHTML = p ? 'Would file into <b style="color:var(--accent)">' + p.folder + '</b> — ' + escapeHtml(p.reason || '') : ''; });
  el('saveRules').addEventListener('click', async () => { try { const parsed = JSON.parse(el('rulesEditor').value); await api.setRules(parsed); el('rulesErr').textContent = 'Saved ✓'; await refresh(); } catch (err) { el('rulesErr').textContent = 'Invalid JSON: ' + err.message; } });
}
function syncControls() {
  const set = (id, v) => { const e = el(id); if (e) { if (e.type === 'checkbox') e.checked = !!v; else e.value = v; } const o = el(id + 'V'); if (o) o.textContent = (id === 'longPressMs') ? (v / 1000).toFixed(1) : v; };
  set('accent', config.accent); set('nodeScale', config.nodeScale); set('labelScale', config.labelScale);
  set('threshold', config.threshold); set('repulsion', config.repulsion); set('linkTension', config.linkTension);
  set('packing', config.packing); set('animSpeed', config.animSpeed); set('longPressMs', config.longPressMs);
  set('ripples', config.ripples); set('sound', config.sound); set('showMinimap', config.showMinimap); set('showSuggestions', config.showSuggestions); set('inertia', config.inertia);
  { const s = el('stagger'); if (s) s.checked = config.reveal === 'stagger'; }
  { const e = el('curvedEdges'); if (e) e.checked = (config.edgeStyle || 'curved') === 'curved'; }
  document.querySelectorAll('#themeRow .chip').forEach(c => c.classList.toggle('active', c.dataset.theme === config.theme));
  document.querySelectorAll('#bgRow .chip').forEach(c => c.classList.toggle('active', c.dataset.bg === config.background));
  renderFolderColors();
}
function renderFolderColors() {
  const box = el('folderColors'); if (!box || !graph) return; box.innerHTML = '';
  const folders = [...new Set(graph.nodes.filter(n => n.type === 'note').map(n => n.folder))].sort();
  for (const f of folders) {
    const row = document.createElement('div'); row.className = 'fc-row';
    const cur = (config.folderColors && config.folderColors[f]) || graph.colorFor(f);
    row.innerHTML = '<input type="color" value="' + toHex(cur) + '"><span>' + escapeHtml(f) + '</span>';
    row.querySelector('input').addEventListener('input', e => { const fc = Object.assign({}, config.folderColors); fc[f] = e.target.value; updateConfig({ folderColors: fc }); });
    box.appendChild(row);
  }
}
async function applyShortcut() {
  const accel = el('quickShortcut').value.trim() || 'Control+Shift+Space';
  const enabled = el('quickCaptureEnabled').checked;
  const r = await api.setSettings({ quickShortcut: accel, quickCaptureEnabled: enabled });
  settings = Object.assign(settings, r);
  const m = el('shortcutMsg');
  if (r.shortcutError) { m.textContent = r.shortcutError; m.style.color = '#f0785e'; }
  else if (!enabled) { m.textContent = 'Global hotkey is off.'; m.style.color = ''; }
  else { m.textContent = 'Bound to ' + r.quickShortcut + '.'; m.style.color = ''; }
}

async function loadRulesEditor() { try { const r = await api.getRules(); el('rulesEditor').value = JSON.stringify(r, null, 2); } catch {} }

// ---------- sound ----------
function playTick() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = 660; g.gain.value = .0001; o.connect(g); g.connect(audioCtx.destination); const t = audioCtx.currentTime; g.gain.exponentialRampToValueAtTime(.08, t + .01); g.gain.exponentialRampToValueAtTime(.0001, t + .18); o.start(t); o.stop(t + .2); } catch {} }

// ---------- helpers ----------
function short(s) { s = String(s || ''); return s.length > 26 ? s.slice(0, 26) + '…' : s; }
function toHex(c) { if (!c) return '#7c9cff'; if (c[0] === '#') return c.length === 4 ? '#' + c.slice(1).split('').map(x => x + x).join('') : c; const m = c.match(/\d+/g); if (!m) return '#7c9cff'; return '#' + m.slice(0, 3).map(x => (+x).toString(16).padStart(2, '0')).join(''); }
function parseFrontmatter(content) {
  const out = { title: null, folder: null, tags: [], body: content };
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) { out.body = content.slice(m[0].length); for (const line of m[1].split('\n')) { const kv = line.match(/^(\w+):\s*(.*)$/); if (!kv) continue; if (kv[1] === 'tags') out.tags = kv[2].replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean); else if (kv[1] === 'title') out.title = kv[2].replace(/^"|"$/g, ''); else if (kv[1] === 'folder') out.folder = kv[2].trim(); } }
  return out;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Undo escapeHtml for text that is about to be re-escaped into an attribute.
// Without this a URL containing & came out as &amp;amp; and broke the link.
function unescapeHtml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function mdToHtml(md) {
  const vault = vaultPath ? vaultPath.replace(/\\/g, '/') : '';
  const resolve = p => /^(https?:|file:|data:)/i.test(p) ? p : 'file://' + vault + '/' + p.replace(/^\.?\//, '');
  let html = escapeHtml(md);
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) =>
    '<img alt="' + alt + '" src="' + escapeHtml(resolve(unescapeHtml(src.trim()))) + '">');
  // Only http(s)/mailto become real links. Anything else (relative paths,
  // javascript:, file:) would navigate the app window away from itself.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => {
    const raw = unescapeHtml(href.trim());
    if (!/^(https?:|mailto:)/i.test(raw)) return '<span class="md-plainlink">' + txt + '</span>';
    return '<a href="' + escapeHtml(raw) + '" target="_blank" rel="noreferrer noopener">' + txt + '</a>';
  });
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, n) =>
    '<a class="wikilink" data-wiki="' + escapeHtml(n) + '">' + n + '</a>');
  html = html.replace(/^######\s?(.*)$/gm, '<h6>$1</h6>').replace(/^#{1,5}\s?(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>');
  return html;
}
let toastTimer = null;
function toast(html) { const t = el('toast'); t.innerHTML = html; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600); }

// A toast with one affordance, for things worth offering but not interrupting for.
function toastAction(html, label, fn) {
  const t = el('toast');
  t.innerHTML = html;
  const b = document.createElement('button');
  b.className = 'ghost small'; b.textContent = label;
  b.onclick = () => { t.classList.add('hidden'); clearTimeout(toastTimer); fn(); };
  t.appendChild(b);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 7000);
}
