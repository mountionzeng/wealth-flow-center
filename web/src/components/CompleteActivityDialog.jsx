import React, { useEffect, useRef, useState } from 'react';

export default function CompleteActivityDialog({ activity, onCancel, onConfirm }) {
  const [duration, setDuration] = useState(String(activity?.planned_duration_minutes || 25));
  const [feeling, setFeeling] = useState('完成了，感受平稳');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const firstRef = useRef(null);
  useEffect(() => {
    firstRef.current?.focus();
    const onKey = event => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
  const submit = async event => {
    event.preventDefault();
    const minutes = Number(duration);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) { setError('实际时长请输入 1–720 分钟'); return; }
    if (!feeling.trim()) { setError('请写一句真实感受'); return; }
    setBusy(true); setError('');
    try { await onConfirm({ actual_duration_minutes: Math.round(minutes), feeling: feeling.trim() }); }
    catch (err) { setError(err?.message || '保存失败，请重试'); setBusy(false); }
  };
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="completion-dialog" role="dialog" aria-modal="true" aria-labelledby="complete-title">
        <p className="eyebrow">实际执行记录</p>
        <h2 id="complete-title">{activity?.title || '完成这项活动'}</h2>
        <p className="dialog-lead">计划只是提醒，真实发生的时间才会进入下一次建议。</p>
        <form onSubmit={submit}>
          <label>实际进行了多久
            <span className="duration-input"><input ref={firstRef} type="number" min="1" max="720" value={duration} onChange={event => setDuration(event.target.value)} required/><small>分钟</small></span>
          </label>
          <label>完成后的感受
            <textarea rows="3" maxLength="160" value={feeling} onChange={event => setFeeling(event.target.value)} required/>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="dialog-actions"><button type="button" className="secondary-btn" onClick={onCancel} disabled={busy}>稍后记录</button><button type="submit" className="gold-btn" disabled={busy}>{busy ? '正在保存…' : '保存真实记录'}</button></div>
        </form>
      </section>
    </div>
  );
}
