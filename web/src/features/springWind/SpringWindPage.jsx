import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { consentMatches } from '../../dailyBalance.js';
import { confirmedProfilePayload, normalizeProfileDetails } from '../../profileDetails.js';
import { buildSpringWindContext } from '../../springWindContext.js';
import BaziMaterialInput from './BaziMaterialInput.jsx';
import RecognizedProfile from './RecognizedProfile.jsx';
import SavedProfileSummary from './SavedProfileSummary.jsx';
import SpringWindReport from './SpringWindReport.jsx';
import { reportIsCurrent, resolveSpringWindCities } from './springWindReportState.js';
import { createSpringWindInputState, springWindInputReducer } from './springWindInputState.js';

const initialSaved = dailyAPI => {
  const saved = dailyAPI.state().spring_wind;
  return saved && typeof saved === 'object' ? saved : {};
};
const localDate = (value = new Date()) => {
  const pad = item => String(item).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
};
const locationLabel = place => [place?.name, place?.admin1, place?.country].filter(Boolean).join(' · ');

export default function SpringWindPage({ dailyAPI, bridge, quests = [], notify }) {
  const saved = useMemo(() => initialSaved(dailyAPI), [dailyAPI]);
  const savedReport = reportIsCurrent(saved.report, localDate()) ? saved.report : null;
  const [daily, setDaily] = useState(() => dailyAPI.state());
  const [baziState, dispatchBazi] = useReducer(
    springWindInputReducer,
    saved.profile?.bazi || savedReport?.bazi || '',
    createSpringWindInputState,
  );
  const [birthCity, setBirthCity] = useState(saved.profile?.birth_city || savedReport?.birth_city || '');
  const [currentCity, setCurrentCity] = useState(saved.profile?.current_city || savedReport?.current_city || savedReport?.city || '');
  const [question, setQuestion] = useState(saved.profile?.question || savedReport?.question || '');
  const [profileDetails, setProfileDetails] = useState(() => normalizeProfileDetails(saved.profile?.profile_details));
  const [profileConfirmed, setProfileConfirmed] = useState(true);
  const [editingProfile, setEditingProfile] = useState(() => !(saved.profile?.bazi && saved.profile?.birth_city && saved.profile?.current_city));
  const [locations, setLocations] = useState(saved.locations || { birth: null, current: null });
  const [candidates, setCandidates] = useState({ birth: [], current: [] });
  const [locationBusy, setLocationBusy] = useState({ birth: false, current: false });
  const [report, setReport] = useState(savedReport);
  const [step, setStep] = useState(savedReport ? 'done' : 'input');
  const [provider, setProvider] = useState({ provider_name: '未配置', text_available: false, vision_available: false, vision_mode: 'unavailable', retention_policy: '', terms_version: 'unknown' });
  const [environmentProvider, setEnvironmentProvider] = useState({ provider_name: 'Open-Meteo', available: false, fields_version: 'environment-v1', data_scope: '' });
  const [allowEnvironment, setAllowEnvironment] = useState(false);
  const [allowText, setAllowText] = useState(false);
  const [allowImage, setAllowImage] = useState(false);
  const existingTextConsent = daily.consent.purposes.spring_wind_text;
  const [shareBody, setShareBody] = useState(existingTextConsent ? existingTextConsent.categories.includes('body_history') : true);
  const [shareLearning, setShareLearning] = useState(existingTextConsent ? existingTextConsent.categories.includes('learning_history') : true);
  const [shareCalendar, setShareCalendar] = useState(existingTextConsent ? existingTextConsent.categories.includes('calendar_history') : true);
  const [preview, setPreview] = useState('');
  const [recognitionNotice, setRecognitionNotice] = useState('');
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [profileStatus, setProfileStatus] = useState(saved.profile?.bazi || saved.profile?.current_city ? 'saved' : 'idle');
  const previewRef = useRef('');
  const requestRef = useRef(0);
  const inputOperationRef = useRef(0);
  const dragDepthRef = useRef(0);
  const profileTimerRef = useRef(0);
  const profileSaveRef = useRef(0);
  const profileReadyRef = useRef(false);
  const locationsRef = useRef(locations);
  const locationRequestRef = useRef({ birth: 0, current: 0 });

  const clearPreview = useCallback(() => {
    setPreview('');
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = '';
  }, []);
  const dispatchInput = useCallback(action => {
    if (action?.type === 'typed') {
      inputOperationRef.current += 1;
      clearPreview();
      setRecognitionNotice('');
    }
    dispatchBazi(action);
  }, [clearPreview]);

  useEffect(() => { locationsRef.current = locations; }, [locations]);

  useEffect(() => {
    let active = true;
    Promise.allSettled([bridge.aiDisclosure(), bridge.environmentDisclosure()]).then(([ai, environment]) => {
      if (!active) return;
      if (ai.status === 'fulfilled') setProvider(ai.value.provider || ai.value);
      if (environment.status === 'fulfilled') setEnvironmentProvider(environment.value.provider || environment.value);
    });
    return () => { active = false; requestRef.current += 1; };
  }, [bridge]);

  useEffect(() => () => {
    inputOperationRef.current += 1;
    locationRequestRef.current.birth += 1;
    locationRequestRef.current.current += 1;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = '';
  }, []);

  const textCategories = useMemo(() => [
    'bazi', 'profile_details', 'birth_city', 'current_city', 'question', 'environment_facts', 'history_summary',
    ...(shareBody ? ['body_history'] : []),
    ...(shareLearning ? ['learning_history'] : []),
    ...(shareCalendar && daily.calendar_preferences.selected_calendars.length ? ['calendar_history'] : []),
  ], [daily.calendar_preferences.selected_calendars.length, shareBody, shareCalendar, shareLearning]);
  const environmentScope = {
    purpose: 'environment', operation: 'city_environment', provider_name: environmentProvider.provider_name || 'Open-Meteo',
    categories: ['birth_city', 'current_city'], fields_version: environmentProvider.fields_version || 'environment-v1',
    terms_version: environmentProvider.terms_version || environmentProvider.fields_version || 'environment-v1',
  };
  const textScope = {
    purpose: 'spring_wind_text', operation: 'structured_report', provider_name: provider.provider_name || '未配置',
    categories: textCategories, fields_version: 'spring-wind-v3', terms_version: provider.terms_version || 'unknown',
  };
  const imageIsLocal = provider.vision_mode === 'local';
  const imageScope = {
    purpose: 'image_recognition', operation: 'image', provider_name: provider.vision_provider_name || provider.provider_name || '未配置',
    categories: ['bazi_profile_image'], fields_version: 'bazi-profile-image-v2', terms_version: provider.terms_version || 'unknown',
  };
  const hasEnvironmentConsent = consentMatches(daily.consent.purposes.environment, environmentScope);
  const hasTextConsent = consentMatches(daily.consent.purposes.spring_wind_text, textScope);
  const hasImageConsent = imageIsLocal || consentMatches(daily.consent.purposes.image_recognition, imageScope);

  const persistProfile = useCallback(async () => {
    const saveId = ++profileSaveRef.current;
    setProfileStatus('saving');
    try {
      const next = await dailyAPI.saveSpringWindProfile({
        bazi: baziState.text.trim(), birth_city: birthCity.trim(), current_city: currentCity.trim(), question: question.trim(),
        profile_details: profileConfirmed ? confirmedProfilePayload(profileDetails) : normalizeProfileDetails(saved.profile?.profile_details),
      });
      if (saveId === profileSaveRef.current) { setDaily(next); setProfileStatus('saved'); }
    } catch {
      if (saveId === profileSaveRef.current) setProfileStatus('error');
    }
  }, [baziState.text, birthCity, currentCity, dailyAPI, profileConfirmed, profileDetails, question, saved.profile?.profile_details]);

  useEffect(() => {
    if (!profileReadyRef.current) { profileReadyRef.current = true; return undefined; }
    setProfileStatus('saving');
    window.clearTimeout(profileTimerRef.current);
    profileTimerRef.current = window.setTimeout(persistProfile, 500);
    return () => window.clearTimeout(profileTimerRef.current);
  }, [persistProfile]);

  const saveProfileNow = () => {
    window.clearTimeout(profileTimerRef.current);
    void persistProfile();
  };

  const updateCity = (role, value) => {
    locationRequestRef.current[role] += 1;
    setLocationBusy(current => ({ ...current, [role]: false }));
    if (role === 'birth') setBirthCity(value); else setCurrentCity(value);
    const currentSelection = locationsRef.current[role];
    if (currentSelection && currentSelection.query !== value.trim()) {
      const next = { ...locationsRef.current, [role]: null };
      locationsRef.current = next;
      setLocations(next);
      setCandidates(current => ({ ...current, [role]: [] }));
      void dailyAPI.saveSpringWindLocations(next).then(setDaily).catch(() => {});
    }
  };

  const saveLocation = useCallback(async (role, query, selected) => {
    const normalized = selected ? { ...selected, query: query.trim() } : null;
    const next = { ...locationsRef.current, [role]: normalized };
    locationsRef.current = next;
    setLocations(next);
    setCandidates(current => ({ ...current, [role]: [] }));
    setDaily(await dailyAPI.saveSpringWindLocations(next));
    return normalized;
  }, [dailyAPI]);

  const resolveCity = useCallback(async (role, query, force = false) => {
    const city = query.trim();
    if (!city) return null;
    if (!force && locationsRef.current[role]?.id && locationsRef.current[role]?.query === city) return locationsRef.current[role];
    const lookupId = ++locationRequestRef.current[role];
    setLocationBusy(current => ({ ...current, [role]: true }));
    try {
      const result = await bridge.searchCity({ query: city, selected_id: force ? locationsRef.current[role]?.id || null : null });
      if (lookupId !== locationRequestRef.current[role]) return null;
      const location = result.location || result;
      if (location.status === 'confirmed' && location.selected) return await saveLocation(role, city, location.selected);
      setCandidates(current => ({ ...current, [role]: location.candidates || [] }));
      if (location.status === 'needs_confirmation') setError(`“${city}”有多个地点，请选择准确城市。`);
      else setError(`暂时无法确认“${city}”，请补充省份或国家后重试。`);
      return null;
    } catch (cause) {
      if (lookupId !== locationRequestRef.current[role]) return null;
      setError(cause?.code === 'bridge_unavailable' ? '本机桥未连接，暂时无法核对城市' : '城市查询暂时不可用，请稍后重试');
      return null;
    } finally {
      if (lookupId === locationRequestRef.current[role]) setLocationBusy(current => ({ ...current, [role]: false }));
    }
  }, [bridge, saveLocation]);

  const chooseCandidate = async (role, item) => {
    locationRequestRef.current[role] += 1;
    const query = role === 'birth' ? birthCity : currentCity;
    setError('');
    await saveLocation(role, query, item);
  };

  const grantConsent = async (purpose, scope) => {
    const next = await dailyAPI.setConsent(purpose, { granted: true, ...scope, granted_at: new Date().toISOString(), revoked_at: '' });
    setDaily(next);
    return next;
  };

  const readTextFile = useCallback(async file => {
    const operationId = ++inputOperationRef.current;
    clearPreview();
    setRecognitionNotice('');
    dispatchBazi({ type: 'import_started', operationId, fileName: file.name });
    if (file.size > 1024 * 1024) { dispatchBazi({ type: 'import_failed', operationId, error: '文档不能超过 1 MB' }); return; }
    try {
      const text = (await file.text()).trim().slice(0, 500);
      if (operationId !== inputOperationRef.current) return;
      dispatchBazi({ type: 'import_succeeded', operationId, text });
      setError('');
    } catch {
      if (operationId === inputOperationRef.current) dispatchBazi({ type: 'import_failed', operationId, error: '文档读取失败，原有文字已保留' });
    }
  }, [clearPreview]);

  const recognizeFile = useCallback(async file => {
    const operationId = ++inputOperationRef.current;
    clearPreview();
    setRecognitionNotice('');
    dispatchBazi({ type: 'import_started', operationId, fileName: file.name });
    if (file.size > 5 * 1024 * 1024) { dispatchBazi({ type: 'import_failed', operationId, error: '图片不能超过 5 MB' }); return; }
    if (!provider.vision_available) { dispatchBazi({ type: 'import_failed', operationId, error: '当前没有可用的图片识别，请继续手动输入' }); return; }
    if (!hasImageConsent && !allowImage) { dispatchBazi({ type: 'import_failed', operationId, error: '请先同意图片识别传输；原有文字已保留' }); return; }
    previewRef.current = URL.createObjectURL(file);
    setPreview(previewRef.current);
    dispatchBazi({ type: 'recognition_started', operationId });
    setError('');
    try {
      if (!hasImageConsent) await grantConsent('image_recognition', imageScope);
      if (operationId !== inputOperationRef.current) return;
      const bytes = await file.arrayBuffer();
      if (operationId !== inputOperationRef.current) return;
      const result = await bridge.recognizeBazi(bytes, file.type);
      if (operationId !== inputOperationRef.current) return;
      const data = result.data || result;
      const recognizedDetails = normalizeProfileDetails(data.profile_fields);
      dispatchBazi({ type: 'import_succeeded', operationId, text: data.bazi || '' });
      setProfileDetails(recognizedDetails);
      setProfileConfirmed(recognizedDetails.length === 0);
      setRecognitionNotice(recognizedDetails.length ? '' : '这张图片里只读到四柱。若希望分析更多资料，请上传包含性别、公历/农历出生、真太阳时、出生地点或命盘摘要的完整截图。');
      const recognizedBirthPlace = recognizedDetails.find(field => field.key === 'birth_place')?.value;
      if (recognizedBirthPlace) setBirthCity(current => current.trim() ? current : recognizedBirthPlace);
      const detailMessage = recognizedDetails.length ? `，另识别到 ${recognizedDetails.length} 项资料，请核对确认` : '；这张图片没有写出其他资料';
      notify?.(data.source === 'macos_vision' ? `已在这台 Mac 本机识别${detailMessage}，图片没有发送到外部` : `图片识别完成${detailMessage}`);
    } catch (cause) {
      if (operationId === inputOperationRef.current) dispatchBazi({ type: 'import_failed', operationId, error: cause?.message || '识别失败，原有文字已保留' });
    } finally {
      if (operationId === inputOperationRef.current) clearPreview();
    }
  }, [allowImage, bridge, clearPreview, hasImageConsent, imageScope, notify, provider.vision_available]);

  const handleMaterial = useCallback(async file => {
    const name = String(file?.name || '').toLocaleLowerCase();
    const isText = file?.type === 'text/plain' || /\.(txt|text)$/.test(name);
    const isImage = ['image/jpeg', 'image/png', 'image/webp'].includes(file?.type) || /\.(jpe?g|png|webp)$/.test(name);
    setStep('input');
    setEditingProfile(true);
    if (isText) await readTextFile(file);
    else if (isImage) await recognizeFile(file);
    else {
      const operationId = ++inputOperationRef.current;
      clearPreview();
      dispatchBazi({ type: 'import_started', operationId, fileName: file?.name || '' });
      dispatchBazi({ type: 'import_failed', operationId, error: '请使用 TXT、JPG、PNG 或 WebP 素材' });
    }
  }, [clearPreview, readTextFile, recognizeFile]);

  useEffect(() => {
    const carriesFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const enter = event => { if (!carriesFiles(event)) return; event.preventDefault(); dragDepthRef.current += 1; setDragging(true); };
    const over = event => { if (!carriesFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; };
    const leave = event => { if (!carriesFiles(event)) return; dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (!dragDepthRef.current) setDragging(false); };
    const drop = event => { if (!carriesFiles(event)) return; event.preventDefault(); dragDepthRef.current = 0; setDragging(false); const file = event.dataTransfer?.files?.[0]; if (file) void handleMaterial(file); };
    document.addEventListener('dragenter', enter); document.addEventListener('dragover', over); document.addEventListener('dragleave', leave); document.addEventListener('drop', drop);
    return () => { document.removeEventListener('dragenter', enter); document.removeEventListener('dragover', over); document.removeEventListener('dragleave', leave); document.removeEventListener('drop', drop); };
  }, [handleMaterial]);

  const submit = async event => {
    event.preventDefault();
    if (!baziState.text.trim()) { setError('请输入你的四柱八字'); return; }
    const cities = resolveSpringWindCities(birthCity, currentCity);
    if (!cities) { setError('请填写你的城市'); return; }
    const requestId = ++requestRef.current;
    setError(''); setStep('generating');
    try {
      let environmentGranted = hasEnvironmentConsent;
      let textGranted = hasTextConsent;
      if (!environmentGranted && allowEnvironment) { await grantConsent('environment', environmentScope); environmentGranted = true; }
      if (provider.text_available && !textGranted && allowText) { await grantConsent('spring_wind_text', textScope); textGranted = true; }
      if (requestId !== requestRef.current) return;

      let birthLocation = locations.birth;
      let currentLocation = locations.current;
      if (environmentGranted) {
        birthLocation = await resolveCity('birth', birthCity);
        if (!birthLocation) { setStep('input'); return; }
        currentLocation = await resolveCity('current', currentCity);
        if (!currentLocation) { setStep('input'); return; }
      }
      if (requestId !== requestRef.current) return;

      let calendarEvents = [];
      const selectedCalendars = daily.calendar_preferences.selected_calendars || [];
      if (textGranted && shareCalendar && selectedCalendars.length) {
        try { calendarEvents = (await bridge.calendarHistory(selectedCalendars)).events || []; }
        catch { notify?.('所选日历暂不可读，本次会明确标记日历样本为 0'); }
      }
      const allowedCategories = [
        ...(shareBody ? ['body_history'] : []),
        ...(shareLearning ? ['learning_history'] : []),
        ...(shareCalendar && selectedCalendars.length ? ['calendar_history'] : []),
      ];
      const context = buildSpringWindContext({ dailyBalance: daily, quests, calendarEvents, allowedCategories, now: new Date() });
      const result = await bridge.springWind({
        bazi: baziState.text.trim(), birth_city: cities.birth, current_city: cities.current, question: question.trim(),
        profile_details: profileConfirmed ? confirmedProfilePayload(profileDetails) : [],
        birth_location_id: birthLocation?.id || null, current_location_id: currentLocation?.id || null,
        browser_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        context,
        consent_manifest: {
          environment: { granted: environmentGranted, categories: environmentGranted ? environmentScope.categories : [] },
          ai: { granted: textGranted, categories: textGranted ? textScope.categories : [] },
        },
      });
      if (requestId !== requestRef.current) return;
      const nextReport = result.report;
      const reportLocations = {
        birth: nextReport.locations?.birth?.selected ? { ...nextReport.locations.birth.selected, query: cities.birth } : birthLocation,
        current: nextReport.locations?.current?.selected ? { ...nextReport.locations.current.selected, query: cities.current } : currentLocation,
      };
      locationsRef.current = reportLocations;
      setLocations(reportLocations);
      setReport(nextReport);
      const next = await dailyAPI.saveSpringWind({
        profile: { bazi: baziState.text.trim(), birth_city: cities.birth, current_city: cities.current, question: question.trim(), profile_details: profileConfirmed ? confirmedProfilePayload(profileDetails) : [] },
        locations: reportLocations,
        report: nextReport,
      });
      setDaily(next);
      if (requestId === requestRef.current) { setEditingProfile(false); setStep('done'); }
    } catch (cause) {
      if (requestId !== requestRef.current) return;
      setError(cause?.code === 'bridge_unavailable' ? '本机服务未连接；输入和上一次报告仍保存在当前账户' : cause?.message || '生成失败，输入和上一次报告均已保留');
      setStep('input');
    }
  };

  const askAgain = () => { requestRef.current += 1; setStep('input'); setError(''); };
  const solarTerm = report?.version === 'spring-wind-report-2'
    ? report.facts?.find(fact => fact.id === 'calendar.solar_term.current')?.value?.name
    : null;
  const renderCandidates = role => candidates[role].length > 0 && <div className="city-candidates" role="group" aria-label={`${role === 'birth' ? '出生' : '现居'}城市候选`}>
    <small>请选择准确地点</small>{candidates[role].map(item => <button key={item.id} type="button" onClick={() => chooseCandidate(role, item)}>{locationLabel(item)}</button>)}
  </div>;

  return <section className="spring-page" aria-labelledby="spring-title">
    {dragging && <div className="spring-drop-overlay" role="status" aria-live="polite"><div><span>松开素材</span><strong>放进同一个八字输入框</strong><small>TXT、JPG、PNG、WebP 都可以</small></div></div>}
    <header className="spring-hero">
      <div><p className="eyebrow">ASK THE SPRING BREEZE</p><h1 id="spring-title">问 春 风</h1><p>先看可验证的事实，再听传统文化如何提醒今天。</p></div>
      <div className="jieqi-seal"><span>当前节气</span><strong>{solarTerm || '待查询'}</strong><small>{report?.date || localDate()}</small></div>
    </header>

    {step === 'input' && <form className="spring-input-card" onSubmit={submit}>
      {!editingProfile && <SavedProfileSummary bazi={baziState.text} birthCity={birthCity} currentCity={currentCity} details={profileDetails} onEdit={() => setEditingProfile(true)}/>} 
      {editingProfile && <><div className="spring-field"><div className="spring-label"><span>壹</span><label htmlFor="spring-bazi">八字与素材</label></div>
        <BaziMaterialInput state={baziState} dispatch={dispatchInput} onMaterial={handleMaterial} onBlur={saveProfileNow} localVision={imageIsLocal} preview={preview}/>
        {recognitionNotice && <p className="recognition-state" role="status">{recognitionNotice}</p>}
      </div>
      {provider.vision_available && !imageIsLocal && !hasImageConsent && <label className="consent-line spring-consent"><input type="checkbox" checked={allowImage} onChange={event => setAllowImage(event.target.checked)}/><span>仅在你选择图片时，将净化后的图片临时发送给 <strong>{provider.vision_provider_name || provider.provider_name}</strong> 识别；原图不写入账户。{provider.vision_retention_policy || provider.retention_policy}</span></label>}
      <RecognizedProfile
        fields={profileDetails}
        confirmed={profileConfirmed}
        onChange={fields => { setProfileDetails(normalizeProfileDetails(fields)); setProfileConfirmed(false); setError(''); }}
        onConfirm={() => { setProfileDetails(normalizeProfileDetails(profileDetails)); setProfileConfirmed(true); setError(''); notify?.('识别资料已确认，会保存在当前本地账户'); }}
        onClear={() => { setProfileDetails([]); setProfileConfirmed(true); setError(''); notify?.('本次不会使用图片中的其他资料'); }}
      />

      <div className="spring-field"><div className="spring-label"><span>贰</span><span className="spring-label-text">两座城市</span></div>
        <div className="city-pair">
          <label><span>出生城市 <small>成长地域背景</small></span><input maxLength="80" value={birthCity} onChange={event => updateCity('birth', event.target.value)} onBlur={() => { saveProfileNow(); if (hasEnvironmentConsent) void resolveCity('birth', birthCity); }} placeholder="例如：成都"/>{locations.birth?.id && <small className="location-confirmed">✓ {locationLabel(locations.birth)}</small>}{locationBusy.birth && <small>正在核对地点…</small>}{renderCandidates('birth')}</label>
          <label><span>现居城市 <small>天气、AQI 与节气时区</small></span><input maxLength="80" value={currentCity} onChange={event => updateCity('current', event.target.value)} onBlur={() => { saveProfileNow(); if (hasEnvironmentConsent) void resolveCity('current', currentCity); }} placeholder="例如：北京"/>{locations.current?.id && <small className="location-confirmed">✓ {locationLabel(locations.current)}</small>}{locationBusy.current && <small>正在核对地点…</small>}{renderCandidates('current')}</label>
        </div>
        <p className={`spring-profile-state ${profileStatus}`} aria-live="polite">{profileStatus === 'saving' ? '正在保存到当前账户…' : profileStatus === 'error' ? '暂未保存，请稍后再试' : baziState.text.trim() || birthCity.trim() || currentCity.trim() ? '这些资料已为当前账户记住，下次无需重填' : '填写一次后，会自动保存在当前账户'}</p>
        {baziState.text.trim() && birthCity.trim() && currentCity.trim() && profileConfirmed && <button className="profile-finish" type="button" onClick={() => { saveProfileNow(); setEditingProfile(false); notify?.('资料已记住，以后会直接使用'); }}>资料确认，收起</button>}
      </div>
      </>}

      <div className="spring-field"><div className="spring-label"><span>{editingProfile ? '叁' : '壹'}</span><label htmlFor="spring-question">问事儿 <small>可选</small></label></div><textarea id="spring-question" rows="3" maxLength="500" value={question} onChange={event => setQuestion(event.target.value)} onBlur={saveProfileNow} placeholder="今天适合签合同吗？自然变化里有什么值得留意？"/></div>

      <section className="spring-permissions" aria-labelledby="spring-permissions-title"><div><p className="eyebrow">THIS TIME</p><h3 id="spring-permissions-title">本次将使用</h3></div>
        <div className="context-toggles"><label><input type="checkbox" checked={shareBody} onChange={event => setShareBody(event.target.checked)}/>身体签到与真实执行</label><label><input type="checkbox" checked={shareLearning} onChange={event => setShareLearning(event.target.checked)}/>学习与完成记录</label><label><input type="checkbox" checked={shareCalendar} onChange={event => setShareCalendar(event.target.checked)}/>所选 Apple 日历摘要</label></div>
        <p>只发送最近 30 天有界细节和全部历史数字汇总，不发送密码、完整备份、未选日历、地点、参与人或备注。</p>
      </section>

      {environmentProvider.available && !hasEnvironmentConsent && <label className="consent-line spring-consent"><input type="checkbox" checked={allowEnvironment} onChange={event => setAllowEnvironment(event.target.checked)}/><span>允许将出生/现居城市查询发送给 <strong>{environmentProvider.provider_name}</strong>；只有现居地会查询天气、AQI 和近期环境基线。不发送八字、问题或历史。{environmentProvider.data_scope}</span></label>}
      {provider.text_available && !hasTextConsent && <label className="consent-line spring-consent"><input type="checkbox" checked={allowText} onChange={event => setAllowText(event.target.checked)}/><span>允许把上方勾选的有界资料和程序事实临时发送给 <strong>{provider.provider_name}</strong> 生成解释与行动；AI 不能改写事实层。{provider.retention_policy}</span></label>}
      {(hasEnvironmentConsent || hasTextConsent) && <p className="saved-consent-note">已记住本账户的授权；可在“我的”查看或撤回。</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="spring-submit" type="submit">问 春 风</button>
    </form>}

    {step === 'generating' && <section className="spring-loading" aria-live="polite"><div><span/><span/><span/></div><h2>正在整理事实与依据</h2><p>输入已保存在当前浏览器账户；外部服务不会保存到本机 Python 资料库。</p></section>}
    {step === 'done' && report && <SpringWindReport report={report} onAskAgain={askAgain}/>} 
    <p className="spring-disclaimer">传统文化视角 · 仅供参考<br/>不构成医疗诊断、吉凶定论或重大决策依据</p>
  </section>;
}
