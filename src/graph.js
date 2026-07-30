// graph.js — nested, semantic-zoom force graph on <canvas>. No dependencies.
// Folders are bubbles; their notes appear as you zoom in (recursively). Everything
// lives inside one always-visible "Vault" root. Includes: dot-grid background,
// ripples, press/hover feedback, pan inertia, minimap, focus/local graph,
// search-reveal, PNG export, and a theme-driven config object.

(function () {
  const PALETTE = ['#7c9cff', '#5ec8a0', '#f0a35e', '#e879a6', '#b98cff',
                   '#61c0e0', '#e0d15e', '#8fce5e', '#ff8a7a', '#9aa7b5'];
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  // Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour.
  function shade(hex, amount) {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    const num = parseInt(full, 16);
    if (isNaN(num)) return hex;
    const mix = amount >= 0 ? 255 : 0, t = Math.abs(amount);
    const ch = (shift) => {
      const v = (num >> shift) & 255;
      return Math.round(v + (mix - v) * clamp(t, 0, 1));
    };
    return '#' + [ch(16), ch(8), ch(0)].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  const DEFAULT_CFG = {
    palette: PALETTE, background: 'dots',          // dots | grid | solid | none
    gridColor: 'rgba(160,175,195,0.16)', gridSpacing: 40,
    nodeScale: 1, labelScale: 1, folderBase: 34, folderGrow: 16,
    threshold: 58, ramp: 46,
    repulsion: 4200, spring: 0.02, linkTension: 1, packing: 1,
    animSpeed: 1, inertia: true, longPressMs: 2000,
    ripples: true, showMinimap: true, showSuggestions: false,
    reveal: 'fade',       // 'fade' = all children fade together | 'stagger' = 1-by-1 on zoom
    edgeStyle: 'curved'   // 'curved' = web-like arcs | 'straight'
  };

  class SynapseGraph {
    constructor(canvas, handlers = {}) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.h = handlers;
      this.cfg = Object.assign({}, DEFAULT_CFG);
      this.nodes = []; this.links = []; this.suggestions = []; this.map = new Map();
      this.folderColor = new Map(); this.folderColorOverride = {};
      this.filterEdges = new Set(['wikilink', 'tag', 'parent']);
      this.search = ''; this.transform = { x: 0, y: 0, k: 1 }; this.anim = null;
      this.hover = null; this.selected = new Set(); this.opened = null;
      this.focusSet = null; this.alpha = 0;
      this.ripples = []; this.panVel = null; this.minimapRect = null;
      this.dragNode = null; this.panning = false; this.held = null; this.linkFrom = null;
      this.ghost = { x: 0, y: 0 }; this._lpTimer = null; this._hoverTimer = null;
      this._bind(); this._resize();
      window.addEventListener('resize', () => this._resize());
      if (window.ResizeObserver) new ResizeObserver(() => this._resize()).observe(canvas);

      // The loop used to run forever, so a minimised window still burned a core
      // and drained the battery. Sleep while the page is hidden.
      this._awake = true; this._active = true; this._looping = true;
      if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('visibilitychange', () => this._setAwake(!document.hidden));
        window.addEventListener('blur', () => { if (document.hidden) this._setAwake(false); });
        window.addEventListener('focus', () => this._setAwake(true));
      }

      requestAnimationFrame(() => this._tick());
    }

    // Two independent reasons to stop: the page is hidden (_awake), or this pane
    // is not on screen (_active). The loop runs only when both allow it.
    _shouldRun() { return this._awake !== false && this._active !== false; }
    _restart() { if (this._shouldRun() && !this._looping) { this._looping = true; requestAnimationFrame(() => this._tick()); } }

    _setAwake(on) {
      if (this._awake === on) return;
      this._awake = on;
      this._looping = false;
      if (on) { this.reheat(.3); this._restart(); }
    }
    /** Called by the host when a pane is shown or hidden. */
    setActive(on) {
      const next = !!on;
      if (this._active === next) return;
      this._active = next;
      this._looping = false;
      if (next) { this._resize(); this.reheat(.6); this._restart(); }
    }

    // Undefined values must never land in cfg: a vault config written by an older
    // build is missing keys, and `nodeScale: undefined` turns every radius into
    // NaN, which silently blanks the whole graph.
    setConfig(patch) {
      for (const [k, v] of Object.entries(patch || {})) if (v !== undefined) this.cfg[k] = v;
      if (patch && patch.folderColors) this.folderColorOverride = patch.folderColors;
      this._sizeNodes(); this.reheat(.4);
    }
    setData(data) {
      const prev = this.map, w = this.canvas.clientWidth || 900, h = this.canvas.clientHeight || 600;
      this.folderColor.clear();
      (data.folders || []).forEach((f, i) => this.folderColor.set(f, this.cfg.palette[i % this.cfg.palette.length]));
      this.suggestions = data.suggestions || [];
      this.nodes = data.nodes.map(n => {
        const p = prev.get(n.id);
        return Object.assign({ x: p ? p.x : w / 2 + (Math.random() - .5) * 340, y: p ? p.y : h / 2 + (Math.random() - .5) * 340, vx: 0, vy: 0 }, n);
      });
      this.map = new Map(this.nodes.map(n => [n.id, n]));
      for (const n of this.nodes) n.parentRef = n.containerId ? this.map.get(n.containerId) : null;
      // stagger order: stable index of each node among its siblings (for 1-2-3 reveal)
      const sibs = new Map();
      for (const n of this.nodes) { const c = n.containerId || ''; if (!sibs.has(c)) sibs.set(c, []); sibs.get(c).push(n); }
      for (const [, arr] of sibs) { arr.sort((a, b) => a.id < b.id ? -1 : 1); arr.forEach((n, i) => { n._si = i; n._sibN = arr.length; }); }
      const byId = this.map;
      this.links = data.links.map(l => ({ source: byId.get(l.source), target: byId.get(l.target), type: l.type })).filter(l => l.source && l.target);
      this._deg = new Map();
      for (const l of this.links) { this._deg.set(l.source.id, (this._deg.get(l.source.id) || 0) + 1); this._deg.set(l.target.id, (this._deg.get(l.target.id) || 0) + 1); }
      this._sizeNodes(); this.reheat(1);
    }
    // Gravitational mass mapping: a note's radius reflects how much substance it
    // carries (body length) and how connected it is (degree). Heavy nodes are
    // also harder to push around in _step, so dense concepts sit still and light
    // ones drift into orbit around them.
    _sizeNodes() {
      const c = this.cfg, deg = this._deg || new Map();
      const massOn = c.massMapping !== false;
      for (const n of this.nodes) {
        if (n.type === 'folder') {
          n.r = (c.folderBase + c.folderGrow * Math.sqrt(n.noteCount || 0));
          n.mass = 6 + Math.sqrt(n.noteCount || 0);
        } else if (n.type === 'note') {
          const d = deg.get(n.id) || 0;
          const linkPart = Math.min(9, d * 1.2);
          // body length contributes on a log curve: 0 chars -> 0, 2k chars -> ~5
          const bodyPart = massOn ? Math.min(6, Math.log10(1 + (n.mass || 0)) * 1.6) : 0;
          n.r = (6 + linkPart + bodyPart) * c.nodeScale;
          n.weight = massOn ? 1 + linkPart * 0.18 + bodyPart * 0.22 : 1;
        } else { n.r = 0; n.weight = 1; }
      }
    }

    // Dynamic colour inheritance: a sub-node takes its parent folder's hue,
    // shaded lighter or darker by depth so nesting reads at a glance.
    colorForNode(n) {
      if (!n) return '#9aa7b5';
      const base = this.colorFor(n.folder);
      if (this.cfg.colorInherit === false) return base;
      let depth = 0, p = n.parentRef;
      while (p && p.type !== 'root' && depth < 6) { depth++; p = p.parentRef; }
      if (depth <= 1) return base;
      return shade(base, (depth - 1) * (n.type === 'folder' ? -0.10 : 0.12));
    }

    setSearch(s) { this.search = (s || '').toLowerCase().trim(); }
    setEdgeTypes(set) { this.filterEdges = set; }
    // world coordinates of a screen point — used to create notes where you clicked
    worldAt(px, py) { return this._toWorld(px, py); }
    // the deepest folder bubble containing a world point (null = vault root)
    folderAtWorld(wx, wy) {
      let best = null, bestR = 1e9; const memo = new Map();
      for (const n of this.nodes) {
        if (n.type !== 'folder') continue;
        if (this._nodeAlpha(n, memo) <= .02 && !this.lensTargets) continue;
        if ((n.x - wx) ** 2 + (n.y - wy) ** 2 <= n.r * n.r && n.r < bestR) { best = n; bestR = n.r; }
      }
      return best;
    }
    selectAllVisible() {
      const memo = new Map();
      for (const n of this.nodes) {
        if (n.type !== 'note') continue;
        if (this._nodeAlpha(n, memo) > .02) this.selected.add(n.id);
      }
      this.h.onSelectionChange && this.h.onSelectionChange([...this.selected]);
    }
    colorFor(folder) { return this.folderColorOverride[folder] || this.folderColor.get(folder) || '#9aa7b5'; }
    reheat(a = .6) { this.alpha = Math.max(this.alpha, a); }
    getSelection() { return [...this.selected]; }
    clearSelection() { this.selected.clear(); }
    exportPNG() { return this.canvas.toDataURL('image/png'); }

    setFocus(id) {
      const n = this.map.get(id); if (!n) { this.focusSet = null; return; }
      const s = new Set([id]);
      for (const l of this.links) { if (l.source.id === id) s.add(l.target.id); if (l.target.id === id) s.add(l.source.id); }
      this.focusSet = s;
    }
    clearFocus() { this.focusSet = null; }

    // ---------- flare ----------
    // Selecting a topic sends a light pulse out along its edges, brightening
    // what it touches while the rest of the graph dims.
    flare(id) {
      const n = this.map.get(id); if (!n) return;
      const reached = new Map([[id, 0]]);
      const frontier = [id];
      const MAX_HOPS = 2;
      while (frontier.length) {
        const cur = frontier.shift();
        const hop = reached.get(cur);
        if (hop >= MAX_HOPS) continue;
        for (const l of this.links) {
          let other = null;
          if (l.source.id === cur) other = l.target.id;
          else if (l.target.id === cur) other = l.source.id;
          if (other && !reached.has(other)) { reached.set(other, hop + 1); frontier.push(other); }
        }
      }
      this._flare = { ids: reached, t0: performance.now(), dur: 1400 / this.cfg.animSpeed };
      this.reheat(.2);
    }
    _flareState() {
      const f = this._flare;
      if (!f) return null;
      const p = (performance.now() - f.t0) / f.dur;
      if (p >= 1) { this._flare = null; return null; }
      return { f, p };
    }
    // How lit a node is right now: 0 = untouched, 1 = fully illuminated.
    _flareGlow(n, state) {
      if (!state) return 0;
      const hop = state.f.ids.get(n.id);
      if (hop == null) return 0;
      // the pulse travels outward: each hop lights up a little later
      const start = hop * 0.22;
      const local = (state.p - start) / 0.42;
      if (local <= 0) return 0;
      return local >= 1 ? Math.max(0, 1 - (state.p - 0.55) / 0.45) : local;
    }

    // ---------- lens engine ----------
    // One-click structural reshape. Each lens assigns target positions; nodes
    // then float and magnetically snap into the new arrangement.
    setLens(name) {
      this.lens = name || null;
      if (!name || name === 'free') { this.lensTargets = null; this.reheat(.9); this._emitLens(); return; }
      const notes = this.nodes.filter(n => n.type === 'note');
      const w = this.canvas.clientWidth || 900, h = this.canvas.clientHeight || 600;
      const cx = w / 2, cy = h / 2;
      const targets = new Map();

      if (name === 'mind') {
        // Temporal: recently touched thoughts pulled to the centre, stale ones
        // pushed to the rim.
        const times = notes.map(n => Date.parse(n.created || '') || 0);
        const newest = Math.max(...times, 1), oldest = Math.min(...times.filter(Boolean), newest);
        const span = Math.max(1, newest - oldest);
        const sorted = notes.slice().sort((a, b) => (Date.parse(b.created || '') || 0) - (Date.parse(a.created || '') || 0));
        sorted.forEach((n, i) => {
          const age = 1 - ((Date.parse(n.created || '') || oldest) - oldest) / span;   // 0 = newest
          const radius = 60 + age * Math.min(w, h) * 0.42;
          const ang = i * 2.399963;                                                    // golden angle
          targets.set(n.id, { x: cx + Math.cos(ang) * radius, y: cy + Math.sin(ang) * radius });
        });
      } else if (name === 'skills') {
        // Prerequisite tree: depth by parent chain, laid out in tidy rows.
        const depthOf = (n) => { let d = 0, p = n; const seen = new Set();
          while (p && p.parentNote && !seen.has(p.id) && d < 12) { seen.add(p.id); p = this.map.get(p.parentNote); d++; }
          return d; };
        const rows = new Map();
        for (const n of notes) { const d = depthOf(n); if (!rows.has(d)) rows.set(d, []); rows.get(d).push(n); }
        const depths = [...rows.keys()].sort((a, b) => a - b);
        const rowGap = Math.max(90, Math.min(160, h / Math.max(1, depths.length)));
        depths.forEach((d, ri) => {
          const row = rows.get(d).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
          const gap = Math.min(120, Math.max(48, w * 0.8 / Math.max(1, row.length)));
          const startX = cx - (row.length - 1) * gap / 2;
          row.forEach((n, i) => targets.set(n.id, { x: startX + i * gap, y: cy - (depths.length - 1) * rowGap / 2 + ri * rowGap }));
        });
      } else if (name === 'knowledge') {
        // Dense encyclopedic clusters: tight packed rings, one per folder.
        const byFolder = new Map();
        for (const n of notes) { const f = n.folder || 'Inbox'; if (!byFolder.has(f)) byFolder.set(f, []); byFolder.get(f).push(n); }
        const folders = [...byFolder.keys()].sort();
        const ringR = Math.min(w, h) * 0.34;
        folders.forEach((f, fi) => {
          const ang = (fi / Math.max(1, folders.length)) * Math.PI * 2;
          const gx = cx + Math.cos(ang) * ringR, gy = cy + Math.sin(ang) * ringR;
          const group = byFolder.get(f);
          const per = Math.ceil(Math.sqrt(group.length));
          const cell = 26;
          group.forEach((n, i) => {
            const col = i % per, row = Math.floor(i / per);
            targets.set(n.id, {
              x: gx + (col - (per - 1) / 2) * cell,
              y: gy + (row - (Math.ceil(group.length / per) - 1) / 2) * cell
            });
          });
        });
      }

      // remember where everything was, so we can ghost the old positions
      this.lensGhosts = notes.map(n => ({ x: n.x, y: n.y, id: n.id, color: this.colorForNode(n) }));
      this.lensGhostT0 = performance.now();
      this.lensTargets = targets;
      this.reheat(1);
      this._emitLens();
    }
    _emitLens() { this.h.onLensChange && this.h.onLensChange(this.lens || 'free'); }

    // ---------- physics ----------
    _step() {
      if (this.alpha < .004 && !this.lensTargets) return;
      const c = this.cfg, w = this.canvas.clientWidth || 900, h = this.canvas.clientHeight || 600;
      const groups = new Map();
      for (const n of this.nodes) { if (n.type === 'root') continue; const g = n.containerId || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
      for (const [, sib] of groups)
        for (let i = 0; i < sib.length; i++)
          for (let j = i + 1; j < sib.length; j++) {
            const a = sib[i], b = sib[j]; let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || .01;
            const d = Math.sqrt(d2), f = c.repulsion / d2, fx = dx / d * f, fy = dy / d * f;
            // heavier nodes shrug off the shove; lighter ones get pushed into orbit
            const wa = a.weight || 1, wb = b.weight || 1;
            a.vx += fx / wa; a.vy += fy / wa; b.vx -= fx / wb; b.vy -= fy / wb;
          }
      for (const l of this.links) {
        const rest = l.type === 'wikilink' ? 84 : l.type === 'parent' ? 70 : 150;
        const kk = (l.type === 'tag' ? c.spring * .4 : c.spring) * c.linkTension;
        let dx = l.target.x - l.source.x, dy = l.target.y - l.source.y, d = Math.sqrt(dx * dx + dy * dy) || .01, f = (d - rest) * kk;
        const fx = dx / d * f, fy = dy / d * f; l.source.vx += fx; l.source.vy += fy; l.target.vx -= fx; l.target.vy -= fy;
      }
      // A lens overrides the usual containment forces: notes are magnetically
      // drawn to their assigned slot instead of orbiting their folder.
      if (this.lensTargets) {
        for (const n of this.nodes) {
          if (n === this.dragNode) continue;
          const t = this.lensTargets.get(n.id);
          if (!t) continue;
          n.vx += (t.x - n.x) * 0.14;
          n.vy += (t.y - n.y) * 0.14;
          n.vx *= .74; n.vy *= .74;
          n.x += n.vx * Math.max(this.alpha, .35);
          n.y += n.vy * Math.max(this.alpha, .35);
        }
      }

      for (const n of this.nodes) {
        if (n.type === 'root') continue;
        if (this.lensTargets && this.lensTargets.has(n.id)) continue;   // lens owns this node
        const p = n.parentRef;
        if (p && p.type !== 'root') {
          let dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy) || .01;
          if (n.type === 'folder') {
            // sub-folders orbit just OUTSIDE the parent circle's rim
            const ring = p.r + n.r + 10;
            const k2 = (d - ring) * 0.09;
            n.vx -= dx / d * k2; n.vy -= dy / d * k2;
          } else {
            // notes are pulled toward the parent and kept INSIDE the bubble
            n.vx += (p.x - n.x) * 0.05 * c.packing; n.vy += (p.y - n.y) * 0.05 * c.packing;
            const maxR = Math.max(12, p.r - n.r - 8);
            if (d > maxR) { n.x = p.x + dx / d * maxR; n.y = p.y + dy / d * maxR; n.vx *= .3; n.vy *= .3; }
          }
        } else { n.vx += (w / 2 - n.x) * 0.02 * this.alpha; n.vy += (h / 2 - n.y) * 0.02 * this.alpha; }
        if (n === this.dragNode) { n.vx = 0; n.vy = 0; continue; }
        n.vx *= .8; n.vy *= .8; n.x += n.vx * this.alpha; n.y += n.vy * this.alpha;
      }
      this.alpha *= .986;
    }

    _containerAlpha(id, memo) {
      if (!id) return 1;
      const node = this.map.get(id);
      if (!node) return 1;
      if (node.type === 'root') return 1;              // Vault root is always open
      if (memo.has(id)) return memo.get(id);
      const base = this._containerAlpha(node.containerId, memo);
      let a = base > 0 ? base * clamp((node.r * this.transform.k - this.cfg.threshold) / this.cfg.ramp, 0, 1) : 0;
      memo.set(id, a); return a;
    }

    // Per-node display alpha. In 'fade' mode this equals the container's openness
    // (unchanged behavior). In 'stagger' mode each sibling reveals in index order
    // as you zoom in, and fades back out in reverse as you zoom out.
    _nodeAlpha(n, memo) {
      // Under a lens the folder bubbles are dissolved and every note is on show,
      // so semantic zoom is bypassed entirely.
      if (this.lensTargets) return n.type === 'note' ? 1 : 0;
      const cid = n.containerId;
      if (!cid) return 1;
      const container = this.map.get(cid);
      if (!container) return 1;
      let baseChain, p;
      if (container.type === 'root') { baseChain = 1; p = 1; }        // Vault root always open
      else {
        baseChain = this._containerAlpha(container.containerId, memo);
        p = baseChain > 0 ? clamp((container.r * this.transform.k - this.cfg.threshold) / this.cfg.ramp, 0, 1) : 0;
      }
      if (baseChain <= 0) return 0;
      const reveal = this.cfg.reveal === 'stagger' ? this._staggerAlpha(n, p) : p;
      return baseChain * reveal;
    }
    _staggerAlpha(n, p) {
      const N = n._sibN || 1, i = n._si || 0, feather = 1.4;          // feather = overlap between reveals
      return clamp((p * (N + feather) - i) / feather, 0, 1);
    }

    // ---------- render ----------
    _tick() {
      // A pane with no layout size (hidden tab, collapsed split) must not draw.
      // Drawing into it burns a core and pushes degenerate geometry at the GPU
      // for a surface nobody can see.
      if (!this._hasSize()) {
        this._looping = false;
        // idle poll rather than rAF, so a hidden pane costs ~4 wakeups/sec
        if (this._shouldRun()) setTimeout(() => { this._looping = true; this._tick(); }, 250);
        return;
      }
      // self-heal: CSS size but a stale backing store (created while hidden, or
      // the display's DPR changed)
      const want = Math.max(1, Math.round(this.canvas.clientWidth * (window.devicePixelRatio || 1)));
      if (!this.canvas.width || !this.canvas.height || Math.abs(this.canvas.width - want) > 1) {
        this._resize(); this.reheat(.6);
      }
      if (!this.dpr) this.dpr = window.devicePixelRatio || 1;

      this._animateCamera(); this._applyInertia(); this._step();
      const ctx = this.ctx, t = this.transform, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._drawBackground(ctx, W, H);
      ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);

      const memo = new Map();
      const aOf = n => this._nodeAlpha(n, memo);
      const expanded = n => n.type === 'folder' && this._containerAlpha(n.id, memo) > .02;
      const flareState = this._flareState();
      const focusDim = n => {
        if (flareState) return 0.16 + 0.84 * this._flareGlow(n, flareState);
        return (this.focusSet && !this.focusSet.has(n.id)) ? .12 : 1;
      };

      this._drawLensGhosts(ctx, t);

      // folder bubbles
      for (const f of this.nodes.filter(n => n.type === 'folder' && aOf(n) > .02).sort((a, b) => b.r - a.r)) {
        const a = aOf(f) * focusDim(f), col = this.colorForNode(f);
        ctx.globalAlpha = a * (expanded(f) ? .5 : 1);
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7);
        if (expanded(f)) { ctx.fillStyle = 'rgba(124,156,255,0.05)'; ctx.fill(); ctx.lineWidth = 1.5 / t.k; ctx.strokeStyle = col; ctx.globalAlpha = a * .6; ctx.stroke(); }
        else { ctx.fillStyle = col; ctx.fill(); if (this.selected.has(f.id)) { ctx.lineWidth = 2.5 / t.k; ctx.strokeStyle = '#fff'; ctx.stroke(); } }
        ctx.globalAlpha = a; ctx.fillStyle = '#e6edf3'; ctx.textAlign = 'center';
        ctx.font = (expanded(f) ? 12 : 13) * this.cfg.labelScale / t.k + 'px -apple-system, Segoe UI, sans-serif';
        ctx.fillText(f.title, f.x, expanded(f) ? f.y - f.r - 6 / t.k : f.y + 4 / t.k);
      }

      // suggested (ghost) links
      if (this.cfg.showSuggestions) {
        for (const s of this.suggestions) {
          const a = this.map.get(s.a), b = this.map.get(s.b); if (!a || !b) continue;
          const al = Math.min(aOf(a), aOf(b)); if (al <= .02) continue;
          ctx.globalAlpha = al * .5; this._edgePath(ctx, a, b);
          ctx.strokeStyle = 'rgba(150,167,181,.5)'; ctx.lineWidth = .8 / t.k; ctx.setLineDash([3 / t.k, 5 / t.k]); ctx.stroke(); ctx.setLineDash([]);
        }
      }

      // edges
      for (const l of this.links) {
        if (!this.filterEdges.has(l.type)) continue;
        const a = Math.min(aOf(l.source), aOf(l.target)) * Math.min(focusDim(l.source), focusDim(l.target)); if (a <= .02) continue;
        ctx.globalAlpha = a; this._edgePath(ctx, l.source, l.target);
        if (l.type === 'wikilink') { ctx.strokeStyle = 'rgba(160,175,195,.6)'; ctx.lineWidth = 1.1 / t.k; }
        else if (l.type === 'parent') { ctx.strokeStyle = 'rgba(240,163,94,.75)'; ctx.lineWidth = 1.6 / t.k; }
        else { ctx.strokeStyle = 'rgba(124,156,255,.15)'; ctx.lineWidth = .8 / t.k; }
        ctx.stroke(); if (l.type === 'parent') this._arrow(ctx, l.source, l.target, a);
      }
      ctx.globalAlpha = 1;

      // notes
      const showLabel = t.k > .6;
      for (const n of this.nodes) {
        if (n.type !== 'note') continue;
        const hit = this.search && n.search && n.search.includes(this.search), dim = this.search && !hit;
        let a = aOf(n) * focusDim(n); if (hit) a = Math.max(a, .9);
        if (a <= .02) continue;
        const glow = flareState ? this._flareGlow(n, flareState) : 0;
        ctx.globalAlpha = a * (dim ? .25 : 1);
        if (glow > .02) {
          // the pulse arriving: a soft halo that fades as it passes
          ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (6 + glow * 10) / t.k, 0, 7);
          ctx.fillStyle = this.colorForNode(n); ctx.globalAlpha = a * glow * .28; ctx.fill();
          ctx.globalAlpha = a * (dim ? .25 : 1);
        }
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7);
        ctx.fillStyle = this.colorForNode(n); ctx.fill();
        // burner notes get a dashed rim that empties as their time runs out
        if (n.expires) this._drawBurner(ctx, n, t, a);
        if (this.selected.has(n.id) || n === this.hover || hit || n.id === this.opened) { ctx.lineWidth = 2 / t.k; ctx.strokeStyle = '#fff'; ctx.stroke(); }
        if (showLabel || n === this.hover || hit) {
          ctx.globalAlpha = a * (dim ? .3 : 1); ctx.fillStyle = '#e6edf3';
          ctx.font = 12 * this.cfg.labelScale / t.k + 'px -apple-system, Segoe UI, sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(n.title.length > 24 ? n.title.slice(0, 24) + '…' : n.title, n.x, n.y + n.r + 12 / t.k);
        }
      }
      ctx.globalAlpha = 1;

      this._drawRipples(ctx, t);
      this._drawHeldAndLink(ctx, t);
      // overlays in screen space
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._drawMarquee(ctx);
      if (this.cfg.showMinimap) this._drawMinimap(ctx, W, H);
      if (this._shouldRun()) { this._looping = true; requestAnimationFrame(() => this._tick()); }
      else this._looping = false;
    }

    _drawBackground(ctx, W, H) {
      const bg = this.cfg.background; if (bg === 'none' || bg === 'solid') return;
      const t = this.transform, S = this.cfg.gridSpacing * clamp(t.k, .5, 2);
      const ox = ((t.x % S) + S) % S, oy = ((t.y % S) + S) % S;
      ctx.fillStyle = this.cfg.gridColor; ctx.strokeStyle = this.cfg.gridColor; ctx.lineWidth = 1;
      if (bg === 'grid') { ctx.beginPath(); for (let x = ox; x < W; x += S) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } for (let y = oy; y < H; y += S) { ctx.moveTo(0, y); ctx.lineTo(W, y); } ctx.stroke(); }
      else { for (let x = ox; x < W; x += S) for (let y = oy; y < H; y += S) { ctx.beginPath(); ctx.arc(x, y, 1.1, 0, 7); ctx.fill(); } }
    }
    // Faint traces of where nodes sat before a lens rearranged them, so the
    // reshape reads as movement rather than teleportation.
    _drawLensGhosts(ctx, t) {
      if (!this.lensGhosts) return;
      const p = (performance.now() - this.lensGhostT0) / (1600 / this.cfg.animSpeed);
      if (p >= 1) { this.lensGhosts = null; return; }
      ctx.globalAlpha = (1 - p) * .35;
      for (const g of this.lensGhosts) {
        const now = this.map.get(g.id);
        ctx.beginPath(); ctx.arc(g.x, g.y, 3 / t.k, 0, 7);
        ctx.fillStyle = g.color; ctx.fill();
        if (now) {
          ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(now.x, now.y);
          ctx.strokeStyle = g.color; ctx.lineWidth = .6 / t.k;
          ctx.setLineDash([2 / t.k, 4 / t.k]); ctx.stroke(); ctx.setLineDash([]);
        }
      }
      ctx.globalAlpha = 1;
    }

    // Dashed rim showing how much life a burner note has left.
    _drawBurner(ctx, n, t, a) {
      const exp = Date.parse(n.expires);
      if (!exp) return;
      const created = Date.parse(n.created || '') || (exp - 86400000);
      const left = clamp((exp - Date.now()) / Math.max(1, exp - created), 0, 1);
      ctx.save();
      ctx.globalAlpha = a * .9;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 3.5 / t.k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      ctx.strokeStyle = left < .2 ? '#f0785e' : '#e0d15e';
      ctx.lineWidth = 1.6 / t.k;
      ctx.setLineDash([2.5 / t.k, 2.5 / t.k]);
      ctx.stroke();
      ctx.restore();
    }

    // Ctrl+drag on empty space draws a selection box over many nodes at once.
    _drawMarquee(ctx) {
      const m = this.marquee; if (!m) return;
      const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
      const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(124,156,255,0.10)';
      ctx.strokeStyle = 'rgba(124,156,255,0.85)';
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + .5, y + .5, w, h);
    }

    _drawRipples(ctx, t) {
      if (!this.ripples.length) return; const now = performance.now();
      this.ripples = this.ripples.filter(r => now - r.t0 < r.dur);
      for (const r of this.ripples) {
        const p = (now - r.t0) / r.dur, rad = r.r0 + (r.r1 - r.r0) * p;
        ctx.globalAlpha = (1 - p) * .7; ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, 7);
        ctx.strokeStyle = r.color; ctx.lineWidth = 2.5 / t.k * (1 - p * .5); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    _drawHeldAndLink(ctx, t) {
      // dragging a note over a valid drop target: ring it so the gesture is legible
      if (this.dropTarget && this.dragNode) {
        const col = this.dropTarget.type === 'folder' ? '#5ec8a0' : '#f0a35e';
        this._ring(ctx, this.dropTarget, col, t);
        ctx.globalAlpha = .10; ctx.beginPath();
        ctx.arc(this.dropTarget.x, this.dropTarget.y, this.dropTarget.r + 6 / t.k, 0, 7);
        ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
      }
      if (this.held) {
        const g = this.ghost;
        ctx.globalAlpha = .32; ctx.beginPath(); ctx.ellipse(g.x + 3 / t.k, g.y + 6 / t.k, this.held.r * 1.6, this.held.r * .7, 0, 0, 7); ctx.fillStyle = '#000'; ctx.fill();
        ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(g.x, g.y, this.held.r * 1.6, 0, 7); ctx.fillStyle = this.colorFor(this.held.folder); ctx.fill();
        ctx.lineWidth = 2 / t.k; ctx.strokeStyle = '#fff'; ctx.stroke();
        const tgt = this._nodeAtWorld(g.x, g.y, this.held); if (tgt) this._ring(ctx, tgt, '#f0a35e', t);
      }
      if (this.linkFrom) {
        ctx.beginPath(); ctx.moveTo(this.linkFrom.x, this.linkFrom.y); ctx.lineTo(this.ghost.x, this.ghost.y);
        ctx.strokeStyle = '#7c9cff'; ctx.lineWidth = 2 / t.k; ctx.setLineDash([6 / t.k, 4 / t.k]); ctx.stroke(); ctx.setLineDash([]);
        const tgt = this._nodeAtWorld(this.ghost.x, this.ghost.y, this.linkFrom); if (tgt) this._ring(ctx, tgt, '#7c9cff', t);
      }
    }
    _ring(ctx, n, col, t) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 6 / t.k, 0, 7); ctx.strokeStyle = col; ctx.lineWidth = 2.5 / t.k; ctx.stroke(); }
    _edgePath(ctx, s, tg) {
      ctx.beginPath(); ctx.moveTo(s.x, s.y);
      if (this.cfg.edgeStyle === 'straight') { ctx.lineTo(tg.x, tg.y); return; }
      const dx = tg.x - s.x, dy = tg.y - s.y, len = Math.hypot(dx, dy) || 1;
      const off = Math.min(len * 0.18, 70);
      const mx = (s.x + tg.x) / 2 + (-dy / len) * off, my = (s.y + tg.y) / 2 + (dx / len) * off;
      ctx.quadraticCurveTo(mx, my, tg.x, tg.y);
    }
    _arrow(ctx, s, tg, a) {
      const ang = Math.atan2(tg.y - s.y, tg.x - s.x), k = this.transform.k;
      const tipX = tg.x - Math.cos(ang) * (tg.r + 2), tipY = tg.y - Math.sin(ang) * (tg.r + 2), len = 7 / k;
      ctx.globalAlpha = a; ctx.fillStyle = 'rgba(240,163,94,.9)'; ctx.beginPath(); ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - Math.cos(ang - .4) * len, tipY - Math.sin(ang - .4) * len); ctx.lineTo(tipX - Math.cos(ang + .4) * len, tipY - Math.sin(ang + .4) * len); ctx.closePath(); ctx.fill();
    }
    _drawMinimap(ctx, W, H) {
      const notes = this.nodes.filter(n => n.type !== 'root'); if (notes.length < 2) { this.minimapRect = null; return; }
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const n of notes) { minx = Math.min(minx, n.x); miny = Math.min(miny, n.y); maxx = Math.max(maxx, n.x); maxy = Math.max(maxy, n.y); }
      const mw = 150, mh = 100, pad = 12, mx = W - mw - pad, my = H - mh - pad;
      const sw = (maxx - minx) || 1, sh = (maxy - miny) || 1, sc = Math.min(mw / sw, mh / sh) * .82;
      const cx = mx + mw / 2, cy = my + mh / 2, gx = (minx + maxx) / 2, gy = (miny + maxy) / 2;
      const P = (x, y) => ({ x: cx + (x - gx) * sc, y: cy + (y - gy) * sc });
      ctx.globalAlpha = .9; ctx.fillStyle = 'rgba(14,17,22,.8)'; ctx.strokeStyle = 'rgba(42,50,61,1)'; ctx.lineWidth = 1;
      this._round(ctx, mx, my, mw, mh, 8); ctx.fill(); ctx.stroke();
      for (const n of notes) { const p = P(n.x, n.y); ctx.globalAlpha = .8; ctx.beginPath(); ctx.arc(p.x, p.y, n.type === 'folder' ? 2.2 : 1.3, 0, 7); ctx.fillStyle = this.colorFor(n.folder); ctx.fill(); }
      // viewport rect
      const tl = this._toWorld(0, 0), br = this._toWorld(W, H), a = P(tl.x, tl.y), b = P(br.x, br.y);
      ctx.globalAlpha = 1; ctx.strokeStyle = '#7c9cff'; ctx.lineWidth = 1.2;
      ctx.strokeRect(clamp(a.x, mx, mx + mw), clamp(a.y, my, my + mh), clamp(b.x - a.x, 4, mw), clamp(b.y - a.y, 4, mh));
      ctx.globalAlpha = 1; this.minimapRect = { mx, my, mw, mh, gx, gy, sc, cx, cy };
    }
    _round(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

    // ---------- camera ----------
    _animateCamera() {
      if (!this.anim) return; const a = this.anim, p = clamp((performance.now() - a.t0) / a.dur, 0, 1);
      const e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      this.transform.x = a.from.x + (a.to.x - a.from.x) * e; this.transform.y = a.from.y + (a.to.y - a.from.y) * e; this.transform.k = a.from.k + (a.to.k - a.from.k) * e;
      if (p >= 1) this.anim = null;
    }
    _applyInertia() {
      if (!this.cfg.inertia || !this.panVel || this.panning) return;
      this.transform.x += this.panVel.x; this.transform.y += this.panVel.y;
      this.panVel.x *= .9; this.panVel.y *= .9;
      if (Math.abs(this.panVel.x) < .1 && Math.abs(this.panVel.y) < .1) this.panVel = null;
    }
    _tween(to, dur) { this.anim = { from: { ...this.transform }, to, t0: performance.now(), dur: dur / this.cfg.animSpeed }; }
    _zoomToNode(n, fill = .42) {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight, k = clamp(Math.min(w, h) * fill / n.r, .2, 4);
      this._tween({ k, x: w / 2 - n.x * k, y: h / 2 - n.y * k }, 520); this.reheat(.4); this._emitPath(n.type === 'folder' ? n.id : n.containerId);
    }
    focusNote(id) {
      const n = this.map.get(id); if (!n) return; let need = 1.15, a = n.parentRef;
      while (a && a.type !== 'root') { need = Math.max(need, (this.cfg.threshold + this.cfg.ramp + 6) / a.r); a = a.parentRef; }
      const k = clamp(need, .3, 4.5), w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this._tween({ k, x: w / 2 - n.x * k, y: h / 2 - n.y * k }, 560); this.opened = id; this.reheat(.5); this._emitPath(n.containerId);
    }
    fit() {
      const roots = this.nodes.filter(n => n.containerId === '__root__'); if (!roots.length) return;
      let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
      for (const n of roots) { minx = Math.min(minx, n.x - n.r); miny = Math.min(miny, n.y - n.r); maxx = Math.max(maxx, n.x + n.r); maxy = Math.max(maxy, n.y + n.r); }
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight, k = clamp(Math.min(w / (maxx - minx + 90), h / (maxy - miny + 90)), .2, 2);
      this._tween({ k, x: w / 2 - (minx + maxx) / 2 * k, y: h / 2 - (miny + maxy) / 2 * k }, 500); this._emitPath('__root__');
    }
    home() { this.clearFocus(); this.fit(); }
    getPath(id) {
      const path = []; let cur = id;
      while (cur && cur !== '__root__') { const n = this.map.get(cur); if (!n) break; path.unshift({ id: n.id, title: n.title }); cur = n.containerId; }
      return path;
    }
    _emitPath(id) { this.h.onBreadcrumb && this.h.onBreadcrumb(this.getPath(id)); }

    // ---------- hit testing ----------
    // dpr must be set unconditionally: it used to be assigned only after the
    // early-out, so a graph constructed while its container was display:none
    // kept dpr === undefined and every later setTransform() got NaN.
    _resize() {
      this.dpr = window.devicePixelRatio || 1;
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
      return true;
    }
    // Is this canvas actually laid out? A display:none pane has no size and must
    // not be drawn into — there is nothing to fix up and nothing to show.
    _hasSize() { return !!(this.canvas.clientWidth && this.canvas.clientHeight); }
    _toWorld(px, py) { const t = this.transform; return { x: (px - t.x) / t.k, y: (py - t.y) / t.k }; }
    _nodeAt(px, py) { const p = this._toWorld(px, py); return this._nodeAtWorld(p.x, p.y); }
    _nodeAtWorld(wx, wy, exclude) {
      let best = null, bestR = 1e9; const memo = new Map();
      for (const n of this.nodes) {
        if (n === exclude || n.type === 'root') continue;
        if (this._nodeAlpha(n, memo) <= .02) continue;
        const rr = n.r + 4; if ((n.x - wx) ** 2 + (n.y - wy) ** 2 <= rr * rr && n.r < bestR) { best = n; bestR = n.r; }
      }
      return best;
    }
    _isExpandedFolder(n) { return n.type === 'folder' && this._containerAlpha(n.id, new Map()) > .02; }
    _inMinimap(px, py) { const m = this.minimapRect; return m && px >= m.mx && px <= m.mx + m.mw && py >= m.my && py <= m.my + m.mh; }

    // ---------- events ----------
    _bind() {
      const c = this.canvas; let downX = 0, downY = 0, moved = false, downNode = null, downOnCanvas = false, lastT = 0, lastN = null;
      const startLP = node => { this._clearLP(); this._lpTimer = setTimeout(() => { if (downNode === node && !moved && node.type === 'note') { this.held = node; this.ghost = { x: node.x, y: node.y }; this.dragNode = null; this.panning = false; this.h.onPickup && this.h.onPickup(node); } }, this.cfg.longPressMs); };

      c.addEventListener('mousedown', e => {
        downOnCanvas = true; downX = e.offsetX; downY = e.offsetY; moved = false; this.panVel = null;
        if (this._inMinimap(e.offsetX, e.offsetY)) { this._minimapJump(e.offsetX, e.offsetY); this.panning = false; downNode = null; return; }
        const n = this._nodeAt(e.offsetX, e.offsetY); downNode = n;
        if (n && (e.ctrlKey || e.metaKey) && n.type === 'note') { this.linkFrom = n; this.ghost = this._toWorld(e.offsetX, e.offsetY); return; }
        // Ctrl+drag on empty space = rubber-band multi-select
        if (!n && (e.ctrlKey || e.metaKey)) {
          this.marquee = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, add: e.shiftKey };
          this.panning = false; return;
        }
        if (n) { this.dragNode = n; startLP(n); this.reheat(.5); }
        else { this.panning = true; c.style.cursor = 'grabbing'; }
      });

      window.addEventListener('mousemove', e => {
        const r = c.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
        if (Math.abs(ox - downX) + Math.abs(oy - downY) > 5) { moved = true; this._clearLP(); }
        const wp = this._toWorld(ox, oy);
        if (this.marquee) { this.marquee.x1 = ox; this.marquee.y1 = oy; return; }
        if (this.held || this.linkFrom) { this.ghost = wp; return; }
        if (this.dragNode) {
          this.dragNode.x = wp.x; this.dragNode.y = wp.y; this.reheat(.35);
          // live target highlight while dragging a note over something droppable
          this.dropTarget = (this.dragNode.type === 'note' && moved)
            ? this._nodeAtWorld(wp.x, wp.y, this.dragNode) : null;
          // dragging up out of the canvas can mean "spawn / route to a tab"
          if (moved && this.h.onDragOutside) this.h.onDragOutside(e.clientX, e.clientY);
        }
        else if (this.panning) { this.transform.x += e.movementX; this.transform.y += e.movementY; this.anim = null; this.panVel = { x: e.movementX, y: e.movementY }; }
        else { const prev = this.hover; this.hover = this._nodeAt(ox, oy); c.style.cursor = this.hover ? 'pointer' : 'grab'; if (this.hover !== prev) this._hoverChanged(ox, oy); }
      });

      window.addEventListener('mouseup', e => {
        this._clearLP(); const r = c.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;

        if (this.marquee) {
          const m = this.marquee; this.marquee = null;
          const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
          const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
          if (Math.abs(x1 - x0) > 4 && Math.abs(y1 - y0) > 4) {
            if (!m.add) this.selected.clear();
            const a = this._toWorld(x0, y0), b = this._toWorld(x1, y1), memo = new Map();
            for (const n of this.nodes) {
              if (n.type === 'root') continue;
              if (this._nodeAlpha(n, memo) <= .02) continue;
              if (n.x >= a.x && n.x <= b.x && n.y >= a.y && n.y <= b.y) this.selected.add(n.id);
            }
            this.h.onSelectionChange && this.h.onSelectionChange([...this.selected]);
          }
          this.dragNode = null; this.panning = false; downNode = null; downOnCanvas = false;
          return;
        }

        // Dropped outside the canvas (the tab bar) — the host decides what that
        // means: spawn a tab, or route the note into another tab's folder.
        if (this.dragNode && moved && this.h.onDropOutside) {
          const consumed = this.h.onDropOutside(this.dragNode.id, e.clientX, e.clientY);
          if (consumed) {
            this.dragNode = null; this.dropTarget = null; this.panning = false;
            downNode = null; downOnCanvas = false; this.reheat(.5);
            return;
          }
        }

        // Dropping a dragged note onto something is the "caveman" gesture:
        // onto a folder files it there, onto another note nests it beneath.
        if (this.dragNode && this.dragNode.type === 'note' && moved) {
          const tgt = this.dropTarget;
          this.dropTarget = null;
          if (tgt && tgt.type === 'folder' && tgt.id !== this.dragNode.containerId && this.h.onDropInFolder) {
            const dropped = this.dragNode;
            this.dragNode = null; this.panning = false; downNode = null; downOnCanvas = false;
            this.h.onDropInFolder(dropped.id, tgt.id);
            return;
          }
          if (tgt && tgt.type === 'note' && this.h.onMakeChild) {
            const dropped = this.dragNode;
            this.dragNode = null; this.panning = false; downNode = null; downOnCanvas = false;
            this.h.onMakeChild(dropped.id, tgt.id);
            return;
          }
        }
        this.dropTarget = null;

        if (this.held) { const tgt = this._nodeAtWorld(this.ghost.x, this.ghost.y, this.held); if (tgt && this.h.onMakeChild) this.h.onMakeChild(this.held.id, tgt.id); this.held = null; return; }
        if (this.linkFrom) { const tgt = this._nodeAtWorld(this.ghost.x, this.ghost.y, this.linkFrom); if (tgt && tgt.type === 'note' && this.h.onMakeLink) this.h.onMakeLink(this.linkFrom.id, tgt.id); this.linkFrom = null; return; }
        if (!moved && downNode) {
          const now = performance.now(), dbl = (now - lastT < 320 && lastN === downNode); lastT = now; lastN = downNode;
          if (e.shiftKey) this._toggleSelect(downNode);
          else if (dbl && downNode.type === 'note') { this.setFocus(downNode.id); this.h.onFocusGraph && this.h.onFocusGraph(downNode); }
          else if (downNode.type === 'folder') this._zoomToNode(downNode);
          else if (downNode.type === 'note') { this.opened = downNode.id; this.h.onNodeClick && this.h.onNodeClick(downNode); }
        } else if (!moved && !downNode && downOnCanvas) {
          if (this.cfg.ripples) this.rippleAt(this._toWorld(ox, oy).x, this._toWorld(ox, oy).y, this.cfg.palette[0], 4, 60);
          this.h.onBackgroundClick && this.h.onBackgroundClick();
        }
        this.dragNode = null; this.panning = false; downNode = null; downOnCanvas = false; c.style.cursor = this.hover ? 'pointer' : 'grab';
      });

      c.addEventListener('wheel', e => {
        e.preventDefault(); this.anim = null; const s = e.deltaY < 0 ? 1.12 : 1 / 1.12, p = { x: e.offsetX, y: e.offsetY }, b = this._toWorld(p.x, p.y);
        this.transform.k = clamp(this.transform.k * s, .15, 4.5); const a = this._toWorld(p.x, p.y);
        this.transform.x += (a.x - b.x) * this.transform.k; this.transform.y += (a.y - b.y) * this.transform.k;
      }, { passive: false });

      c.addEventListener('contextmenu', e => { e.preventDefault(); const n = this._nodeAt(e.offsetX, e.offsetY); this.h.onContextMenu && this.h.onContextMenu({ x: e.offsetX, y: e.offsetY, world: this._toWorld(e.offsetX, e.offsetY), node: n }); });
    }
    _minimapJump(px, py) { const m = this.minimapRect; if (!m) return; const wx = m.gx + (px - m.cx) / m.sc, wy = m.gy + (py - m.cy) / m.sc; const w = this.canvas.clientWidth, h = this.canvas.clientHeight; this._tween({ k: this.transform.k, x: w / 2 - wx * this.transform.k, y: h / 2 - wy * this.transform.k }, 320); }
    rippleAt(x, y, color, r0 = 6, r1 = 90) { if (!this.cfg.ripples) return; this.ripples.push({ x, y, color: color || this.cfg.palette[0], t0: performance.now(), dur: 900 / this.cfg.animSpeed, r0, r1 }); }
    rippleNote(id) { const n = this.map.get(id); if (n) this.rippleAt(n.x, n.y, this.colorFor(n.folder), 6, 110); }
    _hoverChanged(ox, oy) {
      clearTimeout(this._hoverTimer);
      if (this.hover && this.hover.type === 'note') { const node = this.hover; this._hoverTimer = setTimeout(() => { if (this.hover === node) this.h.onHover && this.h.onHover(node, ox, oy); }, 380); }
      else this.h.onHoverEnd && this.h.onHoverEnd();
    }
    _clearLP() { if (this._lpTimer) { clearTimeout(this._lpTimer); this._lpTimer = null; } }
    _toggleSelect(n) { if (this.selected.has(n.id)) this.selected.delete(n.id); else this.selected.add(n.id); this.h.onSelectionChange && this.h.onSelectionChange([...this.selected]); }
  }
  window.SynapseGraph = SynapseGraph;
})();
