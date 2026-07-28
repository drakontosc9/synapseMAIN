// classifier.js
// Keyword / rule-based sorting + Markdown note parsing.
// Pure CommonJS so it runs in the Electron main process AND in tests.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for',
  'is', 'it', 'this', 'that', 'i', 'you', 'we', 'my', 'me', 'so', 'as', 'be',
  'with', 'was', 'are', 'im', 'ive', 'id', 'ill'
]);

/**
 * Score `text` against each rule and pick the best folder.
 * Returns { folder, score, matched:[keywords], reason }.
 */
function classify(text, config) {
  const rules = (config && config.rules) || [];
  const fallback = (config && config.fallbackFolder) || 'Inbox';
  const hay = ' ' + text.toLowerCase() + ' ';
  const tags = extractTags(text);

  let best = { folder: fallback, score: 0, matched: [], reason: 'no keyword match' };

  for (const rule of rules) {
    let score = 0;
    const matched = [];

    for (const kw of rule.keywords || []) {
      const k = kw.toLowerCase();
      // word-ish match: multi-word phrases matched as substrings,
      // single words matched on boundaries to avoid false hits.
      const hit = k.includes(' ')
        ? hay.includes(' ' + k) || hay.includes(k + ' ')
        : new RegExp('\\b' + escapeRe(k) + '\\b').test(hay);
      if (hit) { score += 2; matched.push(kw); }
    }

    for (const t of rule.tags || []) {
      if (tags.includes(t.toLowerCase())) { score += 3; matched.push('#' + t); }
    }

    if (score > best.score) {
      best = {
        folder: rule.folder,
        score,
        matched,
        reason: 'matched ' + matched.slice(0, 4).join(', ')
      };
    }
  }

  return best;
}

/** Pull #hashtags out of text (returns lowercase, without the #). */
function extractTags(text) {
  const out = [];
  const re = /(^|\s)#([a-z0-9][a-z0-9_-]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[2].toLowerCase());
  return [...new Set(out)];
}

/** Pull [[wikilinks]] out of text (returns the raw target names). */
function extractLinks(text) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].split('|')[0].trim());
  return [...new Set(out)];
}

/**
 * Derive a short, filesystem-safe title from a raw thought.
 * Uses the first line, trims to a handful of meaningful words.
 */
function deriveTitle(text) {
  const firstLine = text.trim().split('\n')[0].trim();
  const clean = firstLine.replace(/[#*_`>\[\]]/g, '').trim();
  if (!clean) return 'Untitled ' + Date.now();
  const words = clean.split(/\s+/).slice(0, 8).join(' ');
  return words.length > 60 ? words.slice(0, 60).trim() + '…' : words;
}

/** Turn any string into a safe filename (no extension). */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'note-' + Date.now();
}

/**
 * Build the full Markdown file (frontmatter + body) for a captured thought.
 */
function buildNote(text, folder, extraTags) {
  const title = deriveTitle(text);
  const tags = [...new Set([...(extraTags || []), ...extractTags(text)])];
  const now = new Date().toISOString();
  const fm = [
    '---',
    'title: ' + JSON.stringify(title),
    'created: ' + now,
    'folder: ' + folder,
    'tags: [' + tags.join(', ') + ']',
    '---',
    ''
  ].join('\n');
  return { title, slug: slugify(title), content: fm + text.trim() + '\n', tags };
}

/**
 * Parse a stored .md file back into structured data for the graph.
 */
function parseNote(content) {
  const fm = {};
  let body = content;
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    body = content.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      let val = kv[2].trim();
      if (kv[1] === 'tags') {
        val = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
      } else {
        val = val.replace(/^"|"$/g, '');
      }
      fm[kv[1]] = val;
    }
  }
  return {
    title: fm.title || null,
    created: fm.created || null,
    folder: fm.folder || null,
    parent: fm.parent || null,
    tags: Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [fm.tags] : []),
    links: extractLinks(body),
    body
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = {
  classify, extractTags, extractLinks, deriveTitle, slugify,
  buildNote, parseNote, STOPWORDS
};
