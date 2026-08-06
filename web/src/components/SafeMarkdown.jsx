import React from 'react';
import { parseSafeMarkdown } from '../safeMarkdown.js';

const Inline = ({ tokens }) => tokens.map((token, index) => {
  if (token.type === 'strong') return <strong key={index}>{token.text}</strong>;
  if (token.type === 'emphasis') return <em key={index}>{token.text}</em>;
  if (token.type === 'link') return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer">{token.text}</a>;
  return <React.Fragment key={index}>{token.text}</React.Fragment>;
});

export default function SafeMarkdown({ content }) {
  const nodes = parseSafeMarkdown(content);
  return <div className="safe-markdown">{nodes.map((node, index) => {
    if (node.type === 'heading') {
      if (node.level === 2) return <h2 key={index}><Inline tokens={node.children}/></h2>;
      if (node.level === 3) return <h3 key={index}><Inline tokens={node.children}/></h3>;
      return <h4 key={index}><Inline tokens={node.children}/></h4>;
    }
    if (node.type === 'quote') return <blockquote key={index}><Inline tokens={node.children}/></blockquote>;
    if (node.type === 'divider') return <hr key={index}/>;
    if (node.type === 'list') return <ul key={index}>{node.items.map((item, itemIndex) => <li key={itemIndex}><Inline tokens={item}/></li>)}</ul>;
    return <p key={index}><Inline tokens={node.children}/></p>;
  })}</div>;
}
