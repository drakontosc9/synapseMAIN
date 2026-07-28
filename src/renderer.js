// renderer.js — orchestration: capture, graph, search, palette, settings, panels.
const api = window.synapse;
const el = id => document.getElementById(id);

let graph = null, vaultPath = null, currentNote = null, editing = false;
let settings = { groupCreate: 'both' };
let config = {};
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

  wireCapture(); wireWorkspace(); wireSettings(); wirePalette();
  applyConfig(config);
  applySettingsToUI();
  await refresh();
})();

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
    showSuggestions: config.showSuggestions, folderColors: config.folderColors || {}
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
      const res = await api.captureThought(text);
      box.value = ''; box.style.height = 'auto'; el('destination').textContent = '';
      await refresh(); showWorkspace(true, true); graph.reheat(1);
      setTimeout(() => { graph.focusNote(res.id); if (config.ripples) graph.rippleNote(res.id); if (config.sound) playTick(); }, 480);
      toast('Filed in <b>' + res.folder + '</b>');
    }
  });
  el('chooseVault').addEventListener('click', async () => { vaultPath = await api.chooseVault(); if (vaultPath) { el('noVault').classList.add('hidden'); setVaultName(); config = await api.getConfig(); applyConfig(config); await refresh(); } });
  el('toGraph').addEventListener('click', () => showWorkspace(true));
}

// ---------- workspace ----------
function wireWorkspace() {
  el('backToCapture').addEventListener('click', () => { showWorkspace(false); el('thought').focus(); });
  el('rescan').addEventListener('click', refresh);
  el('fitBtn').addEventListener('click', () => graph.home());
  el('exportBtn').addEventListener('click', async () => { const r = await api.saveImage(graph.exportPNG()); if (r.ok) toast('Exported PNG'); });
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
  el('saveNote').addEventListener('click', async () => { if (!currentNote) return; await api.writeNote(currentNote.id, el('panelEdit').value); setEditing(false); await refresh(); await openNote({ id: currentNote.id }); toast('Saved'); });

  // search
  wireSearch();

  // global keys
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
    else if (e.key === 'Escape') { hideSearch(); hideCtx(); closePalette(); }
  });
  window.addEventListener('mouseup', () => setTimeout(hideHint, 60));
  window.addEventListener('click', e => { if (!el('ctxmenu').contains(e.target)) hideCtx(); if (!el('search').contains(e.target) && !el('searchResults').contains(e.target)) hideSearch(); });
}

function showWorkspace(on, skipFit) {
  el('workspace').classList.toggle('hidden', !on);
  el('capture').classList.toggle('hidden', on);
  if (on) { graph.reheat(.5); if (!skipFit) setTimeout(() => graph.fit(), 300); }
}
function applySettingsToUI() {
  const mode = settings.groupCreate || 'both';
  const r = document.querySelector('input[name="groupCreate"][value="' + mode + '"]'); if (r) r.checked = true;
  el('newGroupBtn').style.display = (mode === 'empty' || mode === 'both') ? '' : 'none';
}

// ---------- data ----------
async function refresh() { const data = await api.scanVault(); graph.setData(data); buildLegend(); }
function buildLegend() {
  const legend = el('legend'); legend.innerHTML = '';
  const et = new Set(['wikilink', 'tag', 'parent']);
  const mk = (type, label, style) => { const r = document.createElement('div'); r.className = 'legend-row'; r.innerHTML = '<span style="width:16px;border-top:' + style + '"></span><span>' + label + '</span>'; r.onclick = () => { if (et.has(type)) et.delete(type); else et.add(type); r.classList.toggle('off'); graph.setEdgeTypes(new Set(et)); }; return r; };
  legend.appendChild(mk('parent', 'parent → child', '2px solid rgba(240,163,94,.85)'));
  legend.appendChild(mk('wikilink', '[[wikilinks]]', '2px solid rgba(160,175,195,.8)'));
  legend.appendChild(mk('tag', 'shared #tags', '2px dotted rgba(124,156,255,.7)'));
  const tip = document.createElement('div'); tip.className = 'legend-edges'; tip.textContent = 'Click a folder to zoom in · double-click a note to focus'; legend.appendChild(tip);
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
async function createGroup(parentDir) { const name = prompt('Name your new group:'); if (!name || !name.trim()) return; const r = await api.createFolder(name.trim(), parentDir || ''); await refresh(); toast('Created group <b>' + short(r.title) + '</b>'); }
async function doGroupSelected() {
  const ids = graph.getSelection().filter(id => { const n = graph.map.get(id); return n && n.type === 'note'; });
  if (!ids.length) { toast('Shift-click some notes first.'); return; }
  const name = prompt('Group ' + ids.length + ' note(s) into a new folder named:'); if (!name || !name.trim()) return;
  const r = await api.groupNotes(ids, name.trim());
  pushUndo('grouping', async () => { for (const m of (r.moved || [])) await api.moveNote(m.to, m.from.includes('/') ? m.from.slice(0, m.from.lastIndexOf('/')) : ''); await refresh(); });
  graph.clearSelection(); updateSelbar([]); await refresh(); toast('Grouped ' + ids.length + ' note(s) into <b>' + short(name.trim()) + '</b>');
}
async function onImport() {
  const files = await api.importFiles(); if (!files.length) return;
  const block = files.map(f => f.markdown).join('\n\n');
  if (editing) { const ta = el('panelEdit'); ta.value += (ta.value.endsWith('\n') ? '' : '\n\n') + block + '\n'; toast('Inserted ' + files.length + ' attachment(s)'); }
  else { const r = await api.newAttachmentNote(block); await refresh(); toast('Imported ' + files.length + ' file(s) → <b>' + short(r.title) + '</b>'); openNote({ id: r.id }); }
}
async function onAddLink() { const url = prompt('Paste a URL to save as a note:'); if (!url) return; const note = prompt('Optional note about this link:') || ''; const r = await api.importLink(url, note); await refresh(); toast('Saved link → <b>' + short(r.title) + '</b>'); }

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
    add('Clear parent', async () => { await api.setParent(node.id, null); await refresh(); toast('Parent cleared'); });
    add('Reveal file', () => api.reveal(node.id));
  } else if (node && node.type === 'folder') { add('Zoom into folder', () => graph._zoomToNode(node)); if (canEmpty) add('New group inside', () => createGroup(node.id)); }
  else { if (canEmpty) add('New group', () => createGroup('')); add('Fit to view', () => graph.home()); }
  if (!m.children.length) return; m.style.left = x + 'px'; m.style.top = y + 'px'; m.classList.remove('hidden');
}
function hideCtx() { el('ctxmenu').classList.add('hidden'); }

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
  showWorkspace(true, true); const raw = await api.readNote(node.id); const fm = parseFrontmatter(raw);
  currentNote = { id: node.id, ...fm }; graph.opened = node.id; graph.focusNote(node.id);
  el('panel').classList.remove('hidden');
  el('panelFolder').textContent = fm.folder || 'Inbox';
  el('panelTitle').textContent = fm.title || node.id;
  el('panelTags').innerHTML = (fm.tags || []).map(t => '<span class="tag">#' + escapeHtml(t) + '</span>').join('');
  el('panelEdit').value = raw; setEditing(false); renderNote();
  renderBacklinks(node.id); renderSuggestions(node.id);
}
function renderNote() { el('panelView').innerHTML = mdToHtml(currentNote.body || ''); }
function setEditing(on) { editing = on; el('panelView').classList.toggle('hidden', on); el('panelEdit').classList.toggle('hidden', !on); el('panelEditBar').classList.toggle('hidden', !on); el('editToggle').textContent = on ? 'Preview' : 'Edit'; if (on) el('panelEdit').focus(); }
function closePanel() { el('panel').classList.add('hidden'); currentNote = null; graph.opened = null; }

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
    { kind: 'action', label: 'New thought', run: () => { closePalette(); showWorkspace(false); el('thought').focus(); } },
    { kind: 'action', label: 'Fit / Home', run: () => { closePalette(); graph.home(); } },
    { kind: 'action', label: 'New group', run: () => { closePalette(); createGroup(''); } },
    { kind: 'action', label: 'Export graph as PNG', run: async () => { closePalette(); const r = await api.saveImage(graph.exportPNG()); if (r.ok) toast('Exported PNG'); } },
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
function wireSettings() {
  el('settingsBtn').addEventListener('click', openSettings);
  el('closeSettings').addEventListener('click', () => el('settingsModal').classList.add('hidden'));
  el('settingsModal').addEventListener('click', e => { if (e.target === el('settingsModal')) el('settingsModal').classList.add('hidden'); });
  el('resetConfig').addEventListener('click', async () => { config = await api.resetConfig(); applyConfig(config); toast('Reset to defaults'); });

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
    document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('hidden', p.dataset.page !== t.dataset.tab));
  }));

  // theme chips
  const tr = el('themeRow');
  Object.keys(THEMES).forEach(name => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = name; b.dataset.theme = name; b.onclick = () => updateConfig({ theme: name }); tr.appendChild(b); });
  el('accent').addEventListener('input', e => updateConfig({ accent: e.target.value }));
  document.querySelectorAll('#bgRow .chip').forEach(b => b.addEventListener('click', () => updateConfig({ background: b.dataset.bg })));

  const bindToggle = (id, key) => el(id).addEventListener('change', e => updateConfig({ [key]: e.target.checked }));
  ['ripples', 'sound', 'showMinimap', 'showSuggestions', 'inertia'].forEach(k => bindToggle(k, k));
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
function mdToHtml(md) {
  const vault = vaultPath ? vaultPath.replace(/\\/g, '/') : '';
  const resolve = p => /^(https?:|file:|data:)/.test(p) ? p : 'file://' + vault + '/' + p.replace(/^\.?\//, '');
  let html = escapeHtml(md);
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => '<img alt="' + alt + '" src="' + resolve(src.trim()) + '">');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => '<a href="' + escapeHtml(href.trim()) + '" target="_blank" rel="noreferrer">' + txt + '</a>');
  html = html.replace(/\[\[([^\]]+)\]\]/g, (_, n) => '<span style="color:var(--accent)">[[' + escapeHtml(n) + ']]</span>');
  html = html.replace(/^######\s?(.*)$/gm, '<h6>$1</h6>').replace(/^#{1,5}\s?(.*)$/gm, '<h3>$1</h3>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|\W)\*([^*]+)\*/g, '$1<i>$2</i>');
  return html;
}
let toastTimer = null;
function toast(html) { const t = el('toast'); t.innerHTML = html; t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2600); }
