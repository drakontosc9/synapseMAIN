// quick.js — the global quick-capture bar.
// Deliberately tiny: type, Enter, gone. It never opens the graph or blocks on a
// scan, because anything slower than instant means thoughts stop getting caught.

const api = window.synapse;
const input = document.getElementById('quickInput');
const dest = document.getElementById('quickDest');
const status = document.getElementById('quickStatus');

const IDLE_HINT = 'Enter to file · Shift+Enter for a new line';
let previewTimer = null;
let busy = false;
let lastSaved = null;

function reset() {
  input.value = '';
  input.style.height = 'auto';
  dest.textContent = '';
  status.textContent = IDLE_HINT;
  status.className = 'quick-status';
  lastSaved = null;
  busy = false;
  input.focus();
}

function grow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
}

input.addEventListener('input', () => {
  grow();
  clearTimeout(previewTimer);
  const text = input.value.trim();
  if (!text) { dest.textContent = ''; return; }
  previewTimer = setTimeout(async () => {
    try {
      const p = await api.previewThought(text);
      dest.textContent = p ? '→ ' + p.folder : '';
    } catch { dest.textContent = ''; }
  }, 160);
});

input.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.quickHide(); return; }

  // Enter on the confirmation state jumps to the note in the main window
  if (e.key === 'Enter' && !e.shiftKey && lastSaved && !input.value.trim()) {
    e.preventDefault(); api.quickOpenMain(lastSaved); return;
  }
  if (e.key !== 'Enter' || e.shiftKey || busy) return;

  e.preventDefault();
  const text = input.value.trim();
  if (!text) { api.quickHide(); return; }

  busy = true;
  status.textContent = 'Filing…';
  try {
    const res = await api.captureThought(text);
    lastSaved = res.id;
    input.value = '';
    input.style.height = 'auto';
    dest.textContent = '';
    status.innerHTML = 'Filed in <b>' + escapeHtml(res.folder) + '</b> · Enter to open it';
    status.className = 'quick-status ok';
    busy = false;
    setTimeout(() => { if (!input.value.trim()) api.quickHide(); }, 1400);
  } catch (err) {
    busy = false;
    status.textContent = (err && err.message) ? err.message : 'Could not save that thought.';
    status.className = 'quick-status err';
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

if (api.onQuickReset) api.onQuickReset(reset);
reset();
