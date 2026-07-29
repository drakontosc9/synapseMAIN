// graph.js — nested, semantic-zoom force graph on <canvas>. No dependencies.
// Folders are bubbles; their notes appear as you zoom in (recursively). Everything
// lives inside one always-visible "Vault" root. Includes: dot-grid background,
// ripples, press/hover feedback, pan inertia, minimap, focus/local graph,
// search-reveal, PNG export, and a theme-driven config object.

(function () {
  const PALETTE = ['#7c9cff', '#5ec8a0', '#f0a35e', '#e879a6', '#b98cff',
                   '#61c0e0', '#e0d15e', '#8fce5e', '#ff8a7a', '#9aa7b5'];
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  const DEFAULT_CFG = {
    palette: PALETTE, background: 'dots',          // dots | grid | solid | none
    gridColor: 'rgba(160,175,195,0.16)', gridSpacing: 40,
    nodeScale: 1, labelScale: 1, folderBase: 34, folderGrow: 16,
    threshold: 58, ramp: 46,
    repulsion: 4200, spring: 0.02, linkTension: 1, packing: 1,
    animSpeed: 1, inertia: true, longPressMs: 2000,
    ripples: true, showMinimap: true, showSuggestions: false,
    reveal: 'fade'   // 'fade' = all children fade together | 'stagger' = 1-by-1 on zoom
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
      requestAnimationFrame(() => this._tick());
    }

    setConfig(patch) { Object.assign(this.cfg, patch || {}); if (patch && patch.folderColors) this.folderColorOverride = patch.folderColors; this._sizeNodes(); this.reheat(.4); }
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
    _sizeNodes() {
      const c = this.cfg, deg = this._deg || new Map();
      for (const n of this.nodes) {
        if (n.type === 'folder') n.r = (c.folderBase + c.folderGrow * Math.sqrt(n.noteCount || 0));
        else if (n.type === 'note') n.r = (6 + Math.min(9, (deg.get(n.id) || 0) * 1.2)) * c.nodeScale;
        else n.r = 0; // root
      }
    }

    setSearch(s) { this.search = (s || '').toLowerCase().trim(); }
    setEdgeTypes(set) { this.filterEdges = set; }
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

    // ---------- physics ----------
    _step() {
      if (this.alpha < .004) return;
      const c = this.cfg, w = this.canvas.clientWidth || 900, h = this.canvas.clientHeight || 600;
      const groups = new Map();
      for (const n of this.nodes) { if (n.type === 'root') continue; const g = n.containerId || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
      for (const [, sib] of groups)
        for (let i = 0; i < sib.length; i++)
          for (let j = i + 1; j < sib.length; j++) {
            const a = sib[i], b = sib[j]; let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || .01;
            const d = Math.sqrt(d2), f = c.repulsion / d2, fx = dx / d * f, fy = dy / d * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          }
      for (const l of this.links) {
        const rest = l.type === 'wikilink' ? 84 : l.type === 'parent' ? 70 : 150;
        const kk = (l.type === 'tag' ? c.spring * .4 : c.spring) * c.linkTension;
        let dx = l.target.x - l.source.x, dy = l.target.y - l.source.y, d = Math.sqrt(dx * dx + dy * dy) || .01, f = (d - rest) * kk;
        const fx = dx / d * f, fy = dy / d * f; l.source.vx += fx; l.source.vy += fy; l.target.vx -= fx; l.target.vy -= fy;
      }
      for (const n of this.nodes) {
        if (n.type === 'root') continue;
        const p = n.parentRef;
        if (p && p.type !== 'root') {
          n.vx += (p.x - n.x) * 0.05 * c.packing; n.vy += (p.y - n.y) * 0.05 * c.packing;
          let dx = n.x - p.x, dy = n.y - p.y, d = Math.hypot(dx, dy) || .01, maxR = Math.max(12, p.r - n.r - 8);
          if (d > maxR) { n.x = p.x + dx / d * maxR; n.y = p.y + dy / d * maxR; n.vx *= .3; n.vy *= .3; }
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
      // self-heal: if the canvas has a CSS size but a 0×0 backing store (e.g. it was
      // created while hidden and ResizeObserver didn't fire on show), size it now.
      if ((!this.canvas.width || !this.canvas.height) && this.canvas.clientWidth) { this._resize(); this.reheat(.6); }
      this._animateCamera(); this._applyInertia(); this._step();
      const ctx = this.ctx, t = this.transform, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this._drawBackground(ctx, W, H);
      ctx.translate(t.x, t.y); ctx.scale(t.k, t.k);

      const memo = new Map();
      const aOf = n => this._nodeAlpha(n, memo);
      const expanded = n => n.type === 'folder' && this._containerAlpha(n.id, memo) > .02;
      const focusDim = n => (this.focusSet && !this.focusSet.has(n.id)) ? .12 : 1;

      // folder bubbles
      for (const f of this.nodes.filter(n => n.type === 'folder' && aOf(n) > .02).sort((a, b) => b.r - a.r)) {
        const a = aOf(f) * focusDim(f), col = this.colorFor(f.folder);
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
          ctx.globalAlpha = al * .5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
          ctx.strokeStyle = 'rgba(150,167,181,.5)'; ctx.lineWidth = .8 / t.k; ctx.setLineDash([3 / t.k, 5 / t.k]); ctx.stroke(); ctx.setLineDash([]);
        }
      }

      // edges
      for (const l of this.links) {
        if (!this.filterEdges.has(l.type)) continue;
        const a = Math.min(aOf(l.source), aOf(l.target)) * Math.min(focusDim(l.source), focusDim(l.target)); if (a <= .02) continue;
        ctx.globalAlpha = a; ctx.beginPath(); ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y);
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
        ctx.globalAlpha = a * (dim ? .25 : 1); ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 7);
        ctx.fillStyle = this.colorFor(n.folder); ctx.fill();
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
      if (this.cfg.showMinimap) this._drawMinimap(ctx, W, H);
      requestAnimationFrame(() => this._tick());
    }

    _drawBackground(ctx, W, H) {
      const bg = this.cfg.background; if (bg === 'none' || bg === 'solid') return;
      const t = this.transform, S = this.cfg.gridSpacing * clamp(t.k, .5, 2);
      const ox = ((t.x % S) + S) % S, oy = ((t.y % S) + S) % S;
      ctx.fillStyle = this.cfg.gridColor; ctx.strokeStyle = this.cfg.gridColor; ctx.lineWidth = 1;
      if (bg === 'grid') { ctx.beginPath(); for (let x = ox; x < W; x += S) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } for (let y = oy; y < H; y += S) { ctx.moveTo(0, y); ctx.lineTo(W, y); } ctx.stroke(); }
      else { for (let x = ox; x < W; x += S) for (let y = oy; y < H; y += S) { ctx.beginPath(); ctx.arc(x, y, 1.1, 0, 7); ctx.fill(); } }
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
    _resize() { const r = this.canvas.getBoundingClientRect(); if (!r.width || !r.height) return; this.dpr = window.devicePixelRatio || 1; this.canvas.width = r.width * this.dpr; this.canvas.height = r.height * this.dpr; }
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
        if (n) { this.dragNode = n; startLP(n); this.reheat(.5); }
        else { this.panning = true; c.style.cursor = 'grabbing'; }
      });

      window.addEventListener('mousemove', e => {
        const r = c.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
        if (Math.abs(ox - downX) + Math.abs(oy - downY) > 5) { moved = true; this._clearLP(); }
        const wp = this._toWorld(ox, oy);
        if (this.held || this.linkFrom) { this.ghost = wp; return; }
        if (this.dragNode) { this.dragNode.x = wp.x; this.dragNode.y = wp.y; this.reheat(.35); }
        else if (this.panning) { this.transform.x += e.movementX; this.transform.y += e.movementY; this.anim = null; this.panVel = { x: e.movementX, y: e.movementY }; }
        else { const prev = this.hover; this.hover = this._nodeAt(ox, oy); c.style.cursor = this.hover ? 'pointer' : 'grab'; if (this.hover !== prev) this._hoverChanged(ox, oy); }
      });

      window.addEventListener('mouseup', e => {
        this._clearLP(); const r = c.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
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
