// fm.js — frontmatter read/write helpers (pure, unit-tested).

function splitFM(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fm: {}, order: [], body: content, had: false };
  const fm = {}, order = [];
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) { fm[kv[1]] = kv[2]; order.push(kv[1]); }
  }
  return { fm, order, body: content.slice(m[0].length), had: true };
}

function joinFM({ fm, order, body }) {
  const keys = order.slice();
  for (const k of Object.keys(fm)) if (!keys.includes(k)) keys.push(k);
  const lines = keys.filter(k => fm[k] !== undefined && fm[k] !== null).map(k => k + ': ' + fm[k]);
  return '---\n' + lines.join('\n') + '\n---\n' + body;
}

// return new file content with parent set (or cleared when parentId is null)
function setParentContent(content, parentId) {
  const parts = splitFM(content);
  if (parentId) { if (!parts.order.includes('parent')) parts.order.push('parent'); parts.fm.parent = JSON.stringify(parentId); }
  else { delete parts.fm.parent; parts.order = parts.order.filter(k => k !== 'parent'); }
  return joinFM(parts);
}

function getParent(content) {
  const { fm } = splitFM(content);
  return fm.parent ? String(fm.parent).replace(/^"|"$/g, '') : null;
}

// cycle check: readParent(id) -> parentId|null
function wouldCycle(childId, parentId, readParent) {
  let cur = parentId, guard = 0;
  while (cur && guard++ < 200) {
    if (cur === childId) return true;
    cur = readParent(cur);
  }
  return false;
}

module.exports = { splitFM, joinFM, setParentContent, getParent, wouldCycle };
