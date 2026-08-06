import React from 'react';

export default function SavedProfileSummary({ bazi, birthCity, currentCity, details, onEdit }) {
  return <section className="saved-profile-summary" aria-labelledby="saved-profile-title">
    <header><div><p className="eyebrow">REMEMBERED ON THIS DEVICE</p><h3 id="saved-profile-title">你的资料已经记住</h3></div><button type="button" onClick={onEdit}>修改资料</button></header>
    <dl>
      <div><dt>四柱</dt><dd>{bazi}</dd></div>
      <div><dt>出生城市</dt><dd>{birthCity}</dd></div>
      <div><dt>现居城市</dt><dd>{currentCity}</dd></div>
    </dl>
    {details.length > 0 && <div className="saved-profile-details">{details.map(field => <span key={field.key}><small>{field.label}</small>{field.value}</span>)}</div>}
    <p>下次会直接使用，不需要重新填写；资料只保存在当前浏览器账户。</p>
  </section>;
}
