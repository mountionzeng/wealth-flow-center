import React from 'react';
import SafeMarkdown from '../../components/SafeMarkdown.jsx';
import { springWindLetterView } from './springWindReportState.js';

export default function SpringWindReport({ report, onAskAgain }) {
  if (!report) return null;
  const letter = springWindLetterView(report);
  const stages = [
    ['01', '可验证事实', letter.stages?.facts ? '已整理' : '已读取'],
    ['02', '传统文化解读', letter.stages?.culture ? '已生成' : '待补充'],
    ['03', '行动建议', letter.stages?.actions ? '已生成' : '待补充'],
  ];
  return <article className="spring-report-card legacy-report">
    <div className="report-meta"><span>{letter.date}</span><span>{letter.model}</span></div>
    <nav className="spring-process" aria-label="问春风处理流程">
      {stages.map(([number, label, status]) => <span className="spring-process-step" key={number}>
        <b>{number}</b><span><strong>{label}</strong><small>{status}</small></span>
      </span>)}
    </nav>
    <SafeMarkdown content={letter.content}/>
    <footer><span>已结合本次资料整理</span><button type="button" onClick={onAskAgain}>再问春风</button></footer>
  </article>;
}
