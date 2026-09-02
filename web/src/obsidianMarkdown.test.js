import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NOTE_VIEW, parseObsidianMarkdown } from './obsidianMarkdown.js';

test('opens Obsidian notes in a formatted reading view by default', () => {
  assert.equal(DEFAULT_NOTE_VIEW, 'preview');
});

test('parses Obsidian frontmatter, headings, tables, callouts, and code as document structure', () => {
  const nodes = parseObsidianMarkdown(`---
tags: [道教, 三魂七魄]
created: 2026-06-22
---

# 三魂七魄体系

道教认为人一身精神分为 **三魂** 和 **七魄**。

| 魂 | 别名 |
| --- | --- |
| 胎光 | 天魂 |

> [!important] 核心关系
> 胎光是根本。

\`\`\`
胎光 → 爽灵
\`\`\`
`);

  assert.deepEqual(nodes.map(node => node.type), ['heading', 'paragraph', 'table', 'callout', 'code']);
  assert.equal(nodes[0].level, 1);
  assert.equal(nodes[0].children[0].text, '三魂七魄体系');
  assert.equal(nodes[2].headers[0][0].text, '魂');
  assert.equal(nodes[3].title, '核心关系');
  assert.equal(nodes[4].text, '胎光 → 爽灵');
  assert.doesNotMatch(JSON.stringify(nodes), /created|tags/);
});

test('displays Obsidian wiki links without raw brackets', () => {
  const [paragraph] = parseObsidianMarkdown('下一篇 → [[02-胎光-生命之光|胎光]]');
  assert.deepEqual(paragraph.children.at(-1), {
    type: 'wikilink',
    target: '02-胎光-生命之光',
    text: '胎光',
  });
});

test('parses a wiki link nested inside emphasis without exposing brackets', () => {
  const [paragraph] = parseObsidianMarkdown('*下一篇 → [[02-胎光-生命之光]]*');

  assert.deepEqual(paragraph.children, [{
    type: 'emphasis',
    children: [
      { type: 'text', text: '下一篇 → ' },
      {
        type: 'wikilink',
        target: '02-胎光-生命之光',
        text: '02-胎光-生命之光',
      },
    ],
  }]);
  assert.doesNotMatch(JSON.stringify(paragraph), /\[\[/);
});
