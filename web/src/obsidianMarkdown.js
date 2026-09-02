const textToken = text => ({ type: 'text', text });

const safeHref = raw => {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
};

export const DEFAULT_NOTE_VIEW = 'preview';

export const parseObsidianInline = raw => {
  const source = String(raw || '');
  const tokens = [];
  const pattern = /!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|`([^`]+)`|\*\*([^*]+)\*\*|_([^_]+)_|\*([^*]+)\*/g;
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
      tokens.push({ type: 'wikilink', target: match[5].trim(), text: (match[6] || match[5]).trim() });
    } else if (match[7] != null) {
      tokens.push({ type: 'code', text: match[7] });
    } else if (match[8] != null) {
      tokens.push({ type: 'strong', children: parseObsidianInline(match[8]) });
    } else if (match[9] != null || match[10] != null) {
      tokens.push({ type: 'emphasis', children: parseObsidianInline(match[9] || match[10]) });
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) tokens.push(textToken(source.slice(cursor)));
  return tokens.length ? tokens : [textToken(source)];
};

const splitTableRow = raw => String(raw || '')
  .trim()
  .replace(/^\|/, '')
  .replace(/\|$/, '')
  .split(/(?<!\\)\|/)
  .map(cell => cell.replace(/\\\|/g, '|').trim());

const isTableDivider = raw => {
  const cells = splitTableRow(raw);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
};

const withoutFrontmatter = raw => {
  const lines = String(raw || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return lines;
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  return closing > 0 ? lines.slice(closing + 1) : lines;
};

export const parseObsidianMarkdown = raw => {
  const lines = withoutFrontmatter(raw);
  const nodes = [];
  const tableStartsAt = index => index + 1 < lines.length && lines[index].includes('|') && isTableDivider(lines[index + 1]);
  const blockStartsAt = index => {
    const line = lines[index]?.trim() || '';
    return /^#{1,6}\s+/.test(line)
      || /^```/.test(line)
      || /^(?:-{3,}|\*{3,}|_{3,})$/.test(line)
      || /^>\s?/.test(line)
      || /^(?:[-*+]\s+|\d+\.\s+)/.test(line)
      || tableStartsAt(index);
  };

  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) { index += 1; continue; }

    const fence = /^```\s*([^\s`]*)/.exec(trimmed);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push({ type: 'code', language: fence[1] || '', text: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      nodes.push({ type: 'heading', level: heading[1].length, children: parseObsidianInline(heading[2]) });
      index += 1;
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      nodes.push({ type: 'divider' });
      index += 1;
      continue;
    }

    if (tableStartsAt(index)) {
      const headers = splitTableRow(lines[index]).map(parseObsidianInline);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(splitTableRow(lines[index]).map(parseObsidianInline));
        index += 1;
      }
      nodes.push({ type: 'table', headers, rows });
      continue;
    }

    const callout = /^>\s*\[!([^\]]+)\]\s*(.*)$/.exec(trimmed);
    if (callout) {
      const body = [];
      index += 1;
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        body.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      nodes.push({ type: 'callout', kind: callout[1].toLowerCase(), title: callout[2] || '提示', children: parseObsidianInline(body.join(' ')) });
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      nodes.push({ type: 'quote', children: parseObsidianInline(quote.join(' ')) });
      continue;
    }

    const firstItem = /^(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(trimmed);
    if (firstItem) {
      const ordered = Boolean(firstItem[2]);
      const items = [];
      while (index < lines.length) {
        const item = /^(?:([-*+])|(\d+)\.)\s+(.+)$/.exec(lines[index].trim());
        if (!item || Boolean(item[2]) !== ordered) break;
        const task = /^\[([ xX])\]\s+(.+)$/.exec(item[3]);
        items.push({ checked: task ? task[1].toLowerCase() === 'x' : null, children: parseObsidianInline(task ? task[2] : item[3]) });
        index += 1;
      }
      nodes.push({ type: 'list', ordered, items });
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !blockStartsAt(index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length) nodes.push({ type: 'paragraph', children: parseObsidianInline(paragraph.join(' ')) });
  }
  return nodes;
};
