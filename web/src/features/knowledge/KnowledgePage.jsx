import React from 'react';

export default function KnowledgePage({ children }) {
  return (
    <section className="knowledge-page" aria-labelledby="knowledge-title">
      <div className="section-intro compact"><p className="eyebrow">KNOWLEDGE LEDGER</p><h1 id="knowledge-title">知识，是时间留下的复利</h1><p>原有学习任务、倒计时、统计与每周大纲完整保留在这里。</p></div>
      {children}
    </section>
  );
}
