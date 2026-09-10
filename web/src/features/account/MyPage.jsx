import React, { useEffect, useRef, useState } from 'react';
import { accountService } from '../../localData.js';

const syncStatusText = state => ({
  ambiguous: '需要核对是否已写入',
  permission_denied: 'Calendar 尚未授权',
  unavailable: '本机桥暂不可用',
  retryable_failure: '上次写入失败，可安全核对后重试',
  not_synced: '尚未写入这台设备',
}[state] || '等待处理');
const purposeLabels = {
  daily_advice: '今日建议',
  spring_wind_text: '问春风文本生成',
  environment: '城市环境查询',
  image_recognition: '图片识别',
  knowledge_refine: '知识笔记增补',
};

export default function MyPage({ account, api, dailyAPI, bridge, onResolveProjection, projectionBusy, onImported, onLogout }) {
  const fileRef = useRef(null);
  const [daily, setDaily] = useState(() => dailyAPI.state());
  const [calendars, setCalendars] = useState([]);
  const [calendarStatus, setCalendarStatus] = useState('尚未连接本机 Calendar');
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState('');
  useEffect(() => setDaily(dailyAPI.state()), [dailyAPI]);
  const selected = daily.calendar_preferences.selected_calendars || [];
  const loadCalendars = async () => {
    setBusy(true); setCalendarStatus('正在读取可选日历…');
    try {
      const result = await bridge.listCalendars();
      if (result.status !== 'succeeded') {
        setCalendars([]);
        setCalendarStatus(result.status === 'permission_denied' ? 'Calendar 尚未授权，请在系统设置中允许访问' : result.status === 'unavailable' ? '本机 Calendar 暂不可用' : 'Calendar 暂时读取失败，请稍后重试');
        return;
      }
      setCalendars(result.calendars || []);
      setCalendarStatus(result.calendars?.length ? '只会读取你在下方勾选的日历' : 'Calendar 中暂无可选日历');
    } catch (error) {
      setCalendarStatus(error.code === 'bridge_unavailable' ? '本机桥尚未启动；网站本地记录仍可使用' : 'Calendar 暂不可用或尚未授权');
    } finally { setBusy(false); }
  };
  const toggleCalendar = async name => {
    const next = selected.includes(name) ? selected.filter(item => item !== name) : [...selected, name];
    const state = await dailyAPI.setCalendarPreferences({ selected_calendars: next });
    setDaily(state);
  };
  const exportData = () => {
    const blob = new Blob([api.exportData()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `berich-${account.username}.json`; link.click();
    URL.revokeObjectURL(url);
  };
  const importData = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !window.confirm('导入会覆盖当前账户的本地记录，并清除旧设备的日历同步状态。确定继续吗？')) return;
    try { await api.importData(await file.text()); setDaily(dailyAPI.state()); onImported(); }
    catch { window.alert('导入失败，现有数据没有被覆盖。请检查备份文件。'); }
  };
  const pendingProjections = daily.projections.filter(row => !['succeeded', 'pending'].includes(row.state));
  const purposeConsents = daily.consent.purposes || {};
  const revokeConsent = async purpose => {
    const record = purposeConsents[purpose];
    if (!record || record.revoked_at) return;
    setDaily(await dailyAPI.setConsent(purpose, { ...record, revoked_at: new Date().toISOString() }));
  };
  const changePassword = async event => {
    event.preventDefault();
    setPasswordStatus('正在保存…');
    try {
      await accountService.changePassword(account.id, newPassword);
      setNewPassword('');
      setPasswordStatus('密码已更新，学习资料没有变化');
    } catch (error) {
      setPasswordStatus(error?.message || '密码更新失败，请重试');
    }
  };
  return (
    <section className="me-page" aria-labelledby="me-title">
      <div className="section-intro"><p className="eyebrow">LOCAL FIRST</p><h1 id="me-title">我的本地空间</h1><p>账户、身体感受与报告保存在这个浏览器；本机桥只负责临时连接 Calendar 和你选择的 AI 服务。</p></div>
      <div className="settings-grid">
        <article className="settings-panel identity-panel">
          <p className="panel-number">01</p><h2>当前账户</h2>
          <div className="identity-name"><span>{account.display_name.slice(0, 1)}</span><div><strong>{account.display_name}</strong><small>@{account.username}</small></div></div>
          <p className="plain-warning">这是浏览器内的便捷隔离，不是加密保险箱。能访问此浏览器资料的人也可能读取这些本地数据。</p>
          <form className="password-reset" onSubmit={changePassword}>
            <label htmlFor="new-local-password">修改本机密码</label>
            <div><input id="new-local-password" type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={4} autoComplete="new-password" placeholder="输入至少 4 位的新密码" required/><button className="secondary-btn" type="submit">保存密码</button></div>
            <small aria-live="polite">{passwordStatus || '仅修改当前浏览器里的账户，不影响学习资料。'}</small>
          </form>
          <div className="button-row"><button className="gold-btn" type="button" onClick={exportData}>备份全部数据</button><button className="secondary-btn" type="button" onClick={() => fileRef.current?.click()}>导入备份</button></div>
          <input ref={fileRef} hidden type="file" accept="application/json,.json" onChange={importData}/>
        </article>
        <article className="settings-panel calendar-panel">
          <p className="panel-number">02</p><h2>Apple 日历范围</h2>
          <p>{calendarStatus}</p>
          <button className="secondary-btn" type="button" onClick={loadCalendars} disabled={busy}>{busy ? '正在连接…' : '读取我的日历列表'}</button>
          {calendars.length > 0 && <div className="calendar-choices" aria-label="允许读取的日历">
            {calendars.map(name => <label key={name}><input type="checkbox" checked={selected.includes(name)} onChange={() => toggleCalendar(name)}/><span>{name}</span></label>)}
          </div>}
          <small className="privacy-detail">只读取所选日历的名称、标题、开始、结束与时长；不读取地点、参与人、附件或备注。</small>
        </article>
        <article className="settings-panel sync-panel">
          <p className="panel-number">03</p><h2>Calendar 待处理</h2>
          {pendingProjections.length ? <div className="projection-list">{pendingProjections.map(item => {
            const canRetry = item.kind && item.title && item.start && item.end;
            return <div className="projection-row" key={`${item.entity_id}-${item.operation_id}`}><div><strong>{item.title || item.operation_id}</strong><small>{syncStatusText(item.state)}</small></div><button className="secondary-btn" type="button" disabled={!canRetry || projectionBusy?.has(item.operation_id)} onClick={() => onResolveProjection?.(item)}>{projectionBusy?.has(item.operation_id) ? '正在核对…' : item.state === 'ambiguous' ? '核对日历' : canRetry ? '重试写入' : '需回原记录处理'}</button></div>;
          })}</div> : <p className="muted-copy">目前没有需要补写或核对的日历记录。</p>}
          <small className="privacy-detail">所有重试都会先用原来的操作编号核对 Berich 日历；结果不明确时不会直接重复创建。</small>
        </article>
        <article className="settings-panel consent-panel">
          <p className="panel-number">04</p><h2>资料授权</h2>
          <p>每种用途单独保存，可随时撤回；新增资料类别或接收方变化时会重新询问。</p>
          <div className="consent-purpose-list">{Object.entries(purposeLabels).map(([purpose, label]) => {
            const record = purposeConsents[purpose];
            const active = record?.granted && !record.revoked_at;
            return <div key={purpose}><div><strong>{label}</strong><small>{active ? `${record.provider_name} · ${record.categories.join('、')}` : record?.revoked_at ? '已撤回' : '尚未授权'}</small></div>{active && <button className="danger-text" type="button" onClick={() => revokeConsent(purpose)}>撤回</button>}</div>;
          })}</div>
        </article>
        <article className="settings-panel privacy-panel">
          <p className="panel-number">05</p><h2>连接与隐私</h2>
          <ul><li>身体感受不会写入 Calendar。</li><li>问春风报告不会保存到本地 Python 服务。</li><li>导入备份后需重新选择日历并重新同意 AI 传输。</li><li>Obsidian 原文件不会被修改，复习卡只保存本地链接。</li><li>清除站点数据会删除本地账户，请先备份。</li></ul>
          <button className="danger-text" type="button" onClick={onLogout}>退出当前本地账户</button>
        </article>
      </div>
    </section>
  );
}
