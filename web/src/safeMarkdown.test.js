import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSafeMarkdown } from './safeMarkdown.js';

test('parses allowed report structure and keeps raw html inert', () => {
  const nodes = parseSafeMarkdown('## 问春风\n\n> 春风有信\n\n<script>alert(1)</script>\n\n- 一养\n- 一学');
  assert.deepEqual(nodes.map(node => node.type), ['heading', 'quote', 'paragraph', 'list']);
  assert.match(nodes[2].children[0].text, /<script>/);
});

test('allows only https links and never creates image nodes', () => {
  const nodes = parseSafeMarkdown('[典籍](https://example.com) [坏链接](javascript:alert(1)) ![图](https://evil/img.png)');
  const tokens = nodes[0].children;
  assert.equal(tokens.some(token => token.type === 'link' && token.href === 'https://example.com/'), true);
  assert.equal(tokens.some(token => token.type === 'link' && token.href.startsWith('javascript:')), false);
  assert.equal(nodes.some(node => node.type === 'image'), false);
});
