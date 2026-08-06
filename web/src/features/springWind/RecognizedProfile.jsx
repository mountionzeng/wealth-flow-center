import React from 'react';
import { PROFILE_DETAIL_DEFINITIONS } from '../../profileDetails.js';

const confidenceLabel = confidence => ({ high: '清晰', medium: '请核对', low: '可能误读' }[confidence] || '请核对');

export default function RecognizedProfile({ fields, confirmed, onChange, onConfirm, onClear }) {
  if (!fields.length) return null;
  const update = (key, value) => onChange(fields.map(field => field.key === key ? { ...field, value } : field));
  const remove = key => onChange(fields.filter(field => field.key !== key));
  return <section className={`recognized-profile ${confirmed ? 'confirmed' : 'needs-review'}`} aria-labelledby="recognized-profile-title">
    <header>
      <div><p className="eyebrow">VISIBLE IN THE IMAGE</p><h3 id="recognized-profile-title">识别到的其他资料</h3></div>
      <span>{confirmed ? '已确认' : '等待你核对'}</span>
    </header>
    <p>这里只保留图片明确写出的内容，不会从四柱猜测个人资料。修改或删除误读项后再确认。</p>
    <div className="recognized-profile-grid">{fields.map(field => {
      const definition = PROFILE_DETAIL_DEFINITIONS[field.key];
      return <label key={field.key}>
        <span>{definition?.label || field.label}<small className={`confidence-${field.confidence}`}>{confidenceLabel(field.confidence)}</small></span>
        <span className="recognized-profile-control"><input value={field.value} maxLength="160" placeholder={definition?.placeholder || ''} onChange={event => update(field.key, event.target.value)}/><button type="button" onClick={() => remove(field.key)} aria-label={`删除${definition?.label || field.label}`}>×</button></span>
      </label>;
    })}</div>
    <footer><button type="button" className="profile-clear" onClick={onClear}>不使用这些资料</button><button type="button" className="profile-confirm" onClick={onConfirm}>{confirmed ? '已确认，可参与分析' : '确认以上资料'}</button></footer>
  </section>;
}
