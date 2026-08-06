import React, { useEffect, useMemo, useRef, useState } from 'react';
import { consentMatches } from '../../dailyBalance.js';

const pad = value => String(value).padStart(2, '0');
const localDate = (value = new Date()) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
const localDateTime = value => `${localDate(value)} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
const addMinutes = (start, minutes) => {
  const value = new Date(String(start).replace(' ', 'T'));
  value.setMinutes(value.getMinutes() + Number(minutes));
  return localDateTime(value);
};
const uid = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;

const scoreChoices = {
  sleep: ['很差', '偏少', '一般', '不错', '充足'],
  energy: ['很低', '偏低', '平稳', '充沛', '很有劲'],
  mood: ['沉重', '低落', '平静', '愉快', '明亮'],
};

const defaultCheckIn = { sleep: 3, energy: 3, mood: 3, discomfort: '无明显不适', note: '' };

const localAdvice = checkIn => {
  const low = Number(checkIn.energy) <= 2 || Number(checkIn.sleep) <= 2;
  return {
    body: { title: low ? '十分钟舒展与温水' : '轻快步行，松开肩背', reason: low ? '今天先把身体从紧绷里放下来。' : '用轻微活动保持精力流动。', start_time: '10:30', duration_minutes: low ? 10 : 20 },
    learning: { title: low ? '只复习一个旧知识点' : '完成一段专注学习', reason: low ? '睡眠或精力偏低，降低新信息负担。' : '保持一段清晰、能完成的知识投入。', start_time: '15:00', duration_minutes: low ? 20 : 40 },
  };
};

const suggestionLabel = kind => kind === 'body' ? '养身' : '学习';
const projectionLabel = state => ({
  succeeded: '日历已同步',
  ambiguous: '等待核对',
  pending: '正在同步',
  permission_denied: '等待 Calendar 授权',
  unavailable: '本机桥不可用',
  retryable_failure: '等待重试',
  not_synced: '尚未同步',
}[state] || '本地已确认');

export default function TodayPage({ dailyAPI, bridge, quests, onCompleteActivity, onNavigate, onResolveProjection, projectionBusy, notify }) {
  const [daily, setDaily] = useState(() => dailyAPI.state());
  const [checkIn, setCheckIn] = useState(defaultCheckIn);
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState({ provider_name: '本地规则', text_available: false, retention_policy: '未发送到外部服务', terms_version: 'local' });
  const [allowText, setAllowText] = useState(false);
  const [edits, setEdits] = useState({});
  const [status, setStatus] = useState('');
  const [busyIds, setBusyIds] = useState(new Set());
  const confirmLocks = useRef(new Set());
  const requestRef = useRef(0);
  const activeRef = useRef(true);
  const today = localDate();

  useEffect(() => {
    const saved = daily.check_ins.find(item => item.date === today);
    if (saved) setCheckIn({ ...defaultCheckIn, ...saved });
    bridge.aiDisclosure().then(result => setProvider(result.provider || result)).catch(() => {});
  }, [bridge, daily.check_ins, today]);

  useEffect(() => () => { activeRef.current = false; requestRef.current += 1; }, []);

  const selectedCalendars = daily.calendar_preferences.selected_calendars || [];
  const textScope = {
    purpose: 'daily_advice', operation: 'text', provider_name: provider.provider_name || '未配置',
    categories: ['body_check_in', 'actual_summary', 'calendar_summary'],
    fields_version: 'daily-v1', terms_version: provider.terms_version || 'unknown',
  };
  const hasTextConsent = consentMatches(daily.consent.purposes.daily_advice, textScope);

  const actualSummary = useMemo(() => {
    const bodyIds = new Set(daily.advice.flatMap(row => row.suggestions.filter(item => item.kind === 'body').map(item => String(item.id))));
    const bodyMinutes = daily.completions.filter(row => bodyIds.has(String(row.source_id))).reduce((sum, row) => sum + Number(row.actual_duration_minutes || 0), 0);
    const learningMinutes = daily.completions.filter(row => !bodyIds.has(String(row.source_id))).reduce((sum, row) => sum + Number(row.actual_duration_minutes || 0), 0)
      + (quests || []).filter(row => row.status === 'done').reduce((sum, row) => sum + Number(row.actual_duration_minutes ?? row.duration_minutes ?? 0), 0);
    const variance = daily.completions.reduce((sum, row) => sum + Number(row.variance_minutes || 0), 0);
    return { body_minutes: bodyMinutes, learning_minutes: learningMinutes, variance_minutes: variance };
  }, [daily, quests]);

  const generate = async event => {
    event.preventDefault();
    const requestId = ++requestRef.current;
    setBusy(true); setStatus('正在理解今天的状态…');
    try {
      let next = await dailyAPI.saveCheckIn({ date: today, ...checkIn });
      if (requestId !== requestRef.current) return;
      setDaily(next);
      let advice;
      if (provider.text_available && (hasTextConsent || allowText)) {
        if (!hasTextConsent) {
          next = await dailyAPI.setConsent('daily_advice', { granted: true, ...textScope, granted_at: new Date().toISOString() });
          if (requestId !== requestRef.current) return;
          setDaily(next);
        }
        let events = [];
        if (selectedCalendars.length) {
          try { events = (await bridge.calendarHistory(selectedCalendars)).events || []; }
          catch { setStatus('日历历史暂不可用，先依据本地真实记录生成'); }
        }
        if (requestId !== requestRef.current) return;
        const result = await bridge.dailyAdvice({ check_in: checkIn, actual_summary: actualSummary, calendar_events: events });
        advice = result.advice;
      } else {
        advice = localAdvice(checkIn);
        notify?.('未发送个人信息，已生成本地基础建议');
      }
      if (requestId !== requestRef.current) return;
      const suggestions = ['body', 'learning'].map(kind => ({
        id: uid(kind), kind, title: advice[kind].title, reason: advice[kind].reason,
        planned_start: `${today} ${advice[kind].start_time}`,
        planned_duration_minutes: advice[kind].duration_minutes,
      }));
      setDaily(await dailyAPI.storeAdvice({ date: today, suggestions }));
      setEdits({}); setStatus('今日的一养一学已经准备好');
    } catch (error) {
      if (requestId === requestRef.current) setStatus(error?.message || '生成失败，签到已经保存在本地');
    } finally { if (requestId === requestRef.current) setBusy(false); }
  };

  const allSuggestions = daily.advice.filter(row => row.date === today).flatMap(row => row.suggestions);
  const planFor = id => daily.plans.find(plan => String(plan.suggestion_id) === String(id));
  const projectionFor = id => daily.projections.find(row => row.entity_id === String(id));
  const editFor = suggestion => edits[suggestion.id] || { time: String(suggestion.planned_start || '').slice(11, 16), duration: suggestion.planned_duration_minutes };
  const updateEdit = (id, key, value, suggestion) => setEdits(current => ({ ...current, [id]: { ...editFor(suggestion), ...current[id], [key]: value } }));

  const confirmPlan = async suggestion => {
    const key = String(suggestion.id);
    if (confirmLocks.current.has(key)) return;
    const edit = editFor(suggestion);
    const start = `${today} ${edit.time}`;
    const duration = Number(edit.duration);
    if (!/^\d{2}:\d{2}$/.test(edit.time) || duration < 5 || duration > 180) { setStatus('请检查计划时间与时长'); return; }
    confirmLocks.current.add(key);
    setBusyIds(current => new Set(current).add(key));
    const end = addMinutes(start, duration);
    const operationId = `plan-${suggestion.id}`;
    const attemptId = uid('attempt');
    const event = { kind: 'plan', title: `${suggestionLabel(suggestion.kind)}｜${suggestion.title}`, start: start.replace(' ', 'T') + ':00', end: end.replace(' ', 'T') + ':00' };
    let projectionSaved = false;
    try {
      setDaily(await dailyAPI.confirmSuggestion(suggestion.id, { planned_start: start, planned_end: end, planned_duration_minutes: duration }));
      setDaily(await dailyAPI.updateProjection(suggestion.id, { operation_id: operationId, attempt_id: attemptId, state: 'pending', ...event }));
      projectionSaved = true;
      setStatus('计划已保存在本地，正在写入 Berich · 计划…');
      if (!activeRef.current) return;
      const result = await bridge.writeCalendar({ ...event, operation_id: operationId });
      setDaily(await dailyAPI.updateProjection(suggestion.id, { operation_id: operationId, attempt_id: attemptId, state: result.status, event_id: result.event_id }));
      setStatus(result.status === 'succeeded' ? '已写入 Berich · 计划' : result.status === 'ambiguous' ? '日历结果待核对，请勿重复点击' : '本地计划已保存，日历稍后可重试');
    } catch (error) {
      if (projectionSaved) {
        const failure = ['permission_denied', 'unavailable'].includes(error.code) ? error.code : error.code === 'bridge_unavailable' ? 'unavailable' : 'retryable_failure';
        setDaily(await dailyAPI.updateProjection(suggestion.id, { operation_id: operationId, attempt_id: attemptId, state: failure }));
        setStatus('本地计划已保存；当前未写入 Calendar');
      } else {
        setStatus(error?.message || '本地计划保存失败，未调用 Calendar');
      }
    } finally {
      confirmLocks.current.delete(key);
      if (activeRef.current) setBusyIds(current => { const next = new Set(current); next.delete(key); return next; });
    }
  };

  const recent = [...daily.completions].slice(-4).reverse();
  return (
    <section className="today-page" aria-labelledby="today-title">
      <div className="today-hero">
        <div><p className="eyebrow">TODAY · {today}</p><h1 id="today-title">先问身体，<br/>再安排今天</h1><p>十秒签到，换一条养身建议和一条学习建议。计划写进日历，真实执行留给下一次参考。</p></div>
        <div className="today-orbit" aria-hidden="true"><span>一养</span><i>身体</i><span>一学</span></div>
      </div>
      <div className="today-layout">
        <form className="checkin-panel" onSubmit={generate}>
          <div className="panel-heading"><span>01</span><div><h2>身体签到</h2><p>没有标准答案，只记录此刻。</p></div></div>
          {Object.entries(scoreChoices).map(([field, labels]) => <fieldset key={field}><legend>{field === 'sleep' ? '睡眠' : field === 'energy' ? '精力' : '情绪'}</legend><div className="score-row">{labels.map((label, index) => <button key={label} type="button" className={Number(checkIn[field]) === index + 1 ? 'selected' : ''} onClick={() => setCheckIn(current => ({ ...current, [field]: index + 1 }))}><b>{index + 1}</b><small>{label}</small></button>)}</div></fieldset>)}
          <label className="field-label">身体不适<select value={checkIn.discomfort} onChange={event => setCheckIn(current => ({ ...current, discomfort: event.target.value }))}><option>无明显不适</option><option>肩颈</option><option>腰背</option><option>肠胃</option><option>头部</option><option>其他</option></select></label>
          <label className="field-label">补充一句（可选）<textarea maxLength="240" rows="2" value={checkIn.note} onChange={event => setCheckIn(current => ({ ...current, note: event.target.value }))} placeholder="例如：昨晚睡得晚，下午需要开会"/></label>
          {provider.text_available && !hasTextConsent && <label className="consent-line"><input type="checkbox" checked={allowText} onChange={event => setAllowText(event.target.checked)}/><span>我同意将本次签到、真实时长汇总和所选日历的五项字段临时发送给 <strong>{provider.provider_name}</strong>。{provider.retention_policy}</span></label>}
          <button className="gold-btn wide" type="submit" disabled={busy}>{busy ? '正在生成…' : allSuggestions.length ? '重新生成未确认建议' : '生成今日一养一学'}</button>
          {status && <p className="inline-status" aria-live="polite">{status}</p>}
        </form>
        <div className="advice-column">
          <div className="panel-heading"><span>02</span><div><h2>今日建议</h2><p>确认前可以改时间与时长。</p></div></div>
          {!allSuggestions.length && <div className="empty-advice"><b>春风未动</b><p>完成左侧签到后，这里只会出现两件值得做的事。</p></div>}
          {allSuggestions.map(suggestion => {
            const plan = planFor(suggestion.id); const projection = projectionFor(suggestion.id); const edit = editFor(suggestion);
            const projectionNeedsAction = projection && !['succeeded', 'pending'].includes(projection.state);
            const resolvedProjection = projection ? {
              ...projection,
              kind: 'plan',
              title: `${suggestionLabel(suggestion.kind)}｜${suggestion.title}`,
              start: String(plan?.planned_start || suggestion.planned_start || '').replace(' ', 'T') + ':00',
              end: String(plan?.planned_end || addMinutes(plan?.planned_start || suggestion.planned_start, plan?.planned_duration_minutes || suggestion.planned_duration_minutes)).replace(' ', 'T') + ':00',
            } : null;
            return <article className={`advice-card ${suggestion.kind}`} key={suggestion.id}>
              <div className="advice-kind"><span>{suggestion.kind === 'body' ? '养' : '学'}</span>{suggestionLabel(suggestion.kind)}</div>
              <h3>{suggestion.title}</h3><p>{suggestion.reason}</p>
              <div className="plan-edits"><label>时间<input type="time" value={edit.time} disabled={!!plan} onChange={event => updateEdit(suggestion.id, 'time', event.target.value, suggestion)}/></label><label>时长<input type="number" min="5" max="180" value={edit.duration} disabled={!!plan} onChange={event => updateEdit(suggestion.id, 'duration', event.target.value, suggestion)}/><small>分钟</small></label></div>
              {!plan ? <button className="confirm-plan" type="button" disabled={busyIds.has(String(suggestion.id))} onClick={() => confirmPlan(suggestion)}>{busyIds.has(String(suggestion.id)) ? '正在确认…' : '确认并写入计划日历'}</button> : plan.status === 'completed' ? <span className="plan-state done">已记录真实执行</span> : <div className="confirmed-row"><span className={`plan-state ${projection?.state || 'not_synced'}`}>{projectionLabel(projection?.state)}</span>{projectionNeedsAction && <button type="button" disabled={projectionBusy?.has(projection.operation_id)} onClick={() => onResolveProjection?.(resolvedProjection)}>{projectionBusy?.has(projection.operation_id) ? '正在核对…' : projection.state === 'ambiguous' ? '核对日历' : '重试写入'}</button>}<button type="button" onClick={() => onCompleteActivity({ source_type: 'plan', id: suggestion.id, title: suggestion.title, kind: suggestion.kind, planned_duration_minutes: plan.planned_duration_minutes })}>记录实际完成</button></div>}
            </article>;
          })}
          {!selectedCalendars.length && <button className="calendar-setup-cta" type="button" onClick={() => onNavigate('me')}>尚未选择历史日历 · 去“我的”设置</button>}
        </div>
      </div>
      <section className="recent-balance"><div><p className="eyebrow">RECENT TRUTH</p><h2>最近真实记录</h2></div>{recent.length ? <ul>{recent.map(item => <li key={item.id}><span>{item.actual_duration_minutes} 分钟</span><p>{item.feeling}</p><small>与计划相差 {item.variance_minutes > 0 ? '+' : ''}{item.variance_minutes} 分钟</small></li>)}</ul> : <p className="muted-copy">完成一项养身或学习活动后，真实时长会出现在这里。</p>}</section>
      <p className="medical-boundary">养身建议只用于一般生活关照，不构成诊断、治疗或医疗意见。</p>
    </section>
  );
}
