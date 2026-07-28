// search.js — ranked note search. Two modes:
//   exact = true  -> only notes whose title/tags/body literally contain the query
//   exact = false -> "smart": ranked by a relevance score (title > tags > body + fuzzy)
(function () {
  function fuzzy(hay, needle) {
    // subsequence match; returns small positive score if all chars appear in order
    let i = 0, j = 0, run = 0, best = 0;
    while (i < hay.length && j < needle.length) {
      if (hay[i] === needle[j]) { j++; run++; best = Math.max(best, run); } else run = 0;
      i++;
    }
    return j === needle.length ? 1 + best * 0.1 : 0;
  }

  function scoreNote(q, n) {
    const title = (n.title || '').toLowerCase();
    const tags = (n.tags || []).map(t => t.toLowerCase());
    const body = (n.search || title);
    let s = 0;
    if (title === q) s += 30;
    if (title.startsWith(q)) s += 12;
    if (title.includes(q)) s += 10;
    for (const w of title.split(/\s+/)) if (w === q) s += 6;
    for (const t of tags) { if (t === q) s += 8; else if (t.includes(q)) s += 4; }
    if (s === 0 && body.includes(q)) s += 3;          // body-only hit
    if (s === 0) s += fuzzy(title, q) * 2;             // last resort: fuzzy title
    return s;
  }

  function searchNotes(query, notes, opts) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return [];
    const exact = opts && opts.exact;
    const out = [];
    for (const n of notes) {
      if (n.type !== 'note') continue;
      if (exact) {
        const hay = (n.title + ' ' + (n.tags || []).join(' ') + ' ' + (n.search || '')).toLowerCase();
        if (hay.includes(q)) out.push({ node: n, score: scoreNote(q, n) || 1 });
      } else {
        const s = scoreNote(q, n);
        if (s > 0) out.push({ node: n, score: s });
      }
    }
    out.sort((a, b) => b.score - a.score || a.node.title.localeCompare(b.node.title));
    return out.slice(0, 60);
  }

  window.SynapseSearch = { searchNotes, scoreNote };
})();
