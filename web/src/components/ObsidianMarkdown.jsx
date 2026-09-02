import React from 'react';
import { parseObsidianMarkdown } from '../obsidianMarkdown.js';

const Inline = ({ tokens }) => tokens.map((token, index) => {
  if (token.type === 'strong') return <strong key={index}><Inline tokens={token.children}/></strong>;
  if (token.type === 'emphasis') return <em key={index}><Inline tokens={token.children}/></em>;
  if (token.type === 'code') return <code key={index}>{token.text}</code>;
  if (token.type === 'link') return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">{token.text}</a>;
  if (token.type === 'wikilink') return <span key={index} className="obsidian-wikilink" title={token.target}>{token.text}</span>;
  return <React.Fragment key={index}>{token.text}</React.Fragment>;
});

const Heading = ({ node, index }) => {
  const Tag = `h${Math.min(Math.max(node.level, 1), 6)}`;
  return <Tag key={index}><Inline tokens={node.children}/></Tag>;
};

export default function ObsidianMarkdown({ content }) {
  const nodes = parseObsidianMarkdown(content);
  return <div className="safe-markdown obsidian-markdown">{nodes.map((node, index) => {
    if (node.type === 'heading') return <Heading key={index} node={node} index={index}/>;
    if (node.type === 'quote') return <blockquote key={index}><Inline tokens={node.children}/></blockquote>;
    if (node.type === 'callout') return <aside key={index} className={`obsidian-callout ${node.kind}`}><strong>{node.title}</strong>{node.children.some(token => token.text) && <p><Inline tokens={node.children}/></p>}</aside>;
    if (node.type === 'divider') return <hr key={index}/>;
    if (node.type === 'code') return <pre key={index}><code>{node.text}</code></pre>;
    if (node.type === 'table') return <div className="obsidian-table-scroll" key={index}><table><thead><tr>{node.headers.map((cell, cellIndex) => <th key={cellIndex}><Inline tokens={cell}/></th>)}</tr></thead><tbody>{node.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><Inline tokens={cell}/></td>)}</tr>)}</tbody></table></div>;
    if (node.type === 'list') {
      const List = node.ordered ? 'ol' : 'ul';
      return <List key={index}>{node.items.map((item, itemIndex) => <li key={itemIndex}>{item.checked != null && <span className={`obsidian-checkbox ${item.checked ? 'checked' : ''}`} aria-hidden="true">{item.checked ? '✓' : ''}</span>}<Inline tokens={item.children}/></li>)}</List>;
    }
    return <p key={index}><Inline tokens={node.children}/></p>;
  })}</div>;
}
