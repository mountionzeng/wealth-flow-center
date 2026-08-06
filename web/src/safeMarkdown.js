const textToken = text => ({ type: 'text', text });

const safeHref = raw => {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
};

export const parseInline = raw => {
  const source = String(raw || '');
  const tokens = [];
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) tokens.push(textToken(source.slice(cursor, match.index)));
    if (match[1] != null) {
      tokens.push(textToken(match[1] ? `[图片：${match[1]}]` : '[图片已省略]'));
    } else if (match[3] != null) {
      const href = safeHref(match[4]);
      tokens.push(href ? { type: 'link', text: match[3], href } : textToken(match[3]));
    } else if (match[5] != null) {
      tokens.push({ type: 'strong', text: match[5] });
    } else if (match[6] != null) {
      tokens.push({ type: 'emphasis', text: match[6] });
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) tokens.push(textToken(source.slice(cursor)));
  return tokens.length ? tokens : [textToken(source)];
};

export const parseSafeMarkdown = raw => {
  const lines = String(raw || '').replace(/^```(?:markdown|json)?\s*/i, '').replace(/\s*```$/, '').split(/\r?\n/);
  const nodes = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    nodes.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    nodes.push({ type: 'list', items: list.map(item => parseInline(item)) });
    list = [];
  };
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) { flushParagraph(); flushList(); return; }
    const heading = /^(#{2,4})\s+(.+)$/.exec(trimmed);
    if (heading) { flushParagraph(); flushList(); nodes.push({ type: 'heading', level: heading[1].length, children: parseInline(heading[2]) }); return; }
    if (/^---+$/.test(trimmed)) { flushParagraph(); flushList(); nodes.push({ type: 'divider' }); return; }
    if (trimmed.startsWith('> ')) { flushParagraph(); flushList(); nodes.push({ type: 'quote', children: parseInline(trimmed.slice(2)) }); return; }
    const item = /^[-*]\s+(.+)$/.exec(trimmed);
    if (item) { flushParagraph(); list.push(item[1]); return; }
    flushList();
    paragraph.push(trimmed);
  });
  flushParagraph(); flushList();
  return nodes;
};
