import React from 'react';
import { SECTIONS, sectionHash } from '../navigation.js';

export default function AppShell({ section, onSectionChange, account, children }) {
  const navigate = id => {
    window.history.replaceState(null, '', sectionHash(id));
    onSectionChange(id);
  };
  return (
    <div className="berich-shell">
      <header className="shell-masthead">
        <div className="shell-brand">
          <span className="shell-brand-mark" aria-hidden="true">富</span>
          <div><p>BE RICH, MY FRIEND</p><strong>把日子，养成自己的财富</strong></div>
        </div>
        <div className="shell-account"><span aria-hidden="true"/>{account.display_name}<small>数据仅存本机</small></div>
      </header>
      <nav className="primary-nav" aria-label="主要栏目">
        {SECTIONS.map(item => (
          <button key={item.id} type="button" className={section === item.id ? 'active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
            <span className="nav-glyph" aria-hidden="true">{item.glyph}</span>
            <span><strong>{item.label}</strong><small>{item.description}</small></span>
          </button>
        ))}
      </nav>
      <main className={`section-stage section-${section}`} key={section}>{children}</main>
    </div>
  );
}
