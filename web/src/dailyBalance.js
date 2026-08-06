import { normalizeProfileDetails } from './profileDetails.js';

const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const makeId = prefix => `${prefix}-${globalThis.crypto.randomUUID()}`;
const asArray = (value, field) => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 类型无效`);
  return clone(value);
};
const requiredId = (value, field) => {
  const id = String(value || '').trim();
  if (!id) throw new Error(`${field} 缺少 ID`);
  return id;
};
const positiveMinutes = (value, field) => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`${field} 时长无效`);
  return minutes;
};
const assertUnique = (rows, field) => {
  const seen = new Set();
  rows.forEach(row => {
    const id = requiredId(row?.[field], field);
    if (seen.has(id)) throw new Error(`${field} 存在重复 ID: ${id}`);
    seen.add(id);
  });
};

export const CONSENT_PURPOSES = ['daily_advice', 'spring_wind_text', 'environment', 'image_recognition'];
const emptyPurposeConsents = () => Object.fromEntries(CONSENT_PURPOSES.map(purpose => [purpose, null]));

const legacyCategories = purpose => ({
  daily_advice: ['body_check_in', 'actual_summary', 'calendar_summary'],
  spring_wind_text: ['bazi', 'birth_city', 'current_city', 'question', 'environment_facts'],
  environment: ['birth_city', 'current_city'],
  image_recognition: ['bazi_image'],
}[purpose] || []);

const normalizeLocationSelection = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id || '').trim();
  const provider_version = String(value.provider_version || '').trim();
  if (!id) return null;
  return { ...clone(value), id, provider_version };
};

const normalizeSpringWind = value => {
  if (value == null) return null;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawProfile = source.profile && typeof source.profile === 'object' && !Array.isArray(source.profile) ? source.profile : {};
  const rawReport = source.report && typeof source.report === 'object' ? source.report : {};
  const profile = {
    bazi: String(rawProfile.bazi ?? rawReport.bazi ?? ''),
    birth_city: String(rawProfile.birth_city ?? rawReport.birth_city ?? ''),
    current_city: String(rawProfile.current_city ?? rawProfile.city ?? rawReport.current_city ?? rawReport.city ?? ''),
    question: String(rawProfile.question ?? rawReport.question ?? ''),
    profile_details: normalizeProfileDetails(rawProfile.profile_details),
  };
  const rawLocations = source.locations && typeof source.locations === 'object' ? source.locations : {};
  const normalized = {
    profile,
    locations: {
      birth: normalizeLocationSelection(rawLocations.birth),
      current: normalizeLocationSelection(rawLocations.current),
    },
  };
  if (Object.hasOwn(source, 'report')) normalized.report = clone(source.report);
  if (Object.hasOwn(source, 'inputs')) normalized.inputs = clone(source.inputs);
  return normalized;
};

export const createDailyBalanceState = () => ({
  check_ins: [],
  advice: [],
  plans: [],
  completions: [],
  projections: [],
  spring_wind: null,
  consent: { purposes: emptyPurposeConsents() },
  calendar_preferences: { selected_calendars: [] },
});

const normalizeConsent = (value, expectedPurpose = '') => {
  if (!value || typeof value !== 'object' || value.granted !== true) return null;
  const purpose = String(value.purpose || expectedPurpose || '').trim();
  const operation = String(value.operation || '').trim();
  const provider_name = String(value.provider_name || '').trim();
  const fields_version = String(value.fields_version || '').trim();
  const terms_version = String(value.terms_version || '').trim();
  if (!CONSENT_PURPOSES.includes(purpose) || !operation || !provider_name || !fields_version || !terms_version) return null;
  const rawCategories = Array.isArray(value.categories) ? value.categories : legacyCategories(purpose);
  const categories = [...new Set(rawCategories.map(item => String(item || '').trim()).filter(Boolean))].sort();
  if (!categories.length) return null;
  return {
    granted: true,
    purpose,
    operation,
    provider_name,
    categories,
    fields_version,
    terms_version,
    granted_at: String(value.granted_at || ''),
    revoked_at: String(value.revoked_at || ''),
  };
};

const purposeFromLegacyText = value => {
  const version = String(value?.fields_version || '');
  if (version.startsWith('daily-')) return 'daily_advice';
  if (version.startsWith('spring-wind-')) return 'spring_wind_text';
  return null;
};

const normalizePurposeConsents = consent => {
  const purposes = emptyPurposeConsents();
  if (consent?.purposes && typeof consent.purposes === 'object') {
    CONSENT_PURPOSES.forEach(purpose => { purposes[purpose] = normalizeConsent(consent.purposes[purpose], purpose); });
    return purposes;
  }
  const textPurpose = purposeFromLegacyText(consent?.text);
  if (textPurpose) purposes[textPurpose] = normalizeConsent({ ...consent.text, purpose: textPurpose }, textPurpose);
  if (consent?.image) purposes.image_recognition = normalizeConsent({ ...consent.image, purpose: 'image_recognition' }, 'image_recognition');
  return purposes;
};

export const consentMatches = (consent, scope) => {
  const current = normalizeConsent(consent);
  if (!current || !scope || current.revoked_at) return false;
  const expectedCategories = [...new Set((Array.isArray(scope.categories) ? scope.categories : []).map(String).filter(Boolean))].sort();
  return ['purpose', 'operation', 'provider_name', 'fields_version', 'terms_version'].every(key => current[key] === String(scope[key] || ''))
    && expectedCategories.length > 0
    && JSON.stringify(current.categories) === JSON.stringify(expectedCategories);
};

export const normalizeDailyBalanceState = raw => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const state = {
    check_ins: asArray(source.check_ins, 'check_ins'),
    advice: asArray(source.advice, 'advice'),
    plans: asArray(source.plans, 'plans'),
    completions: asArray(source.completions, 'completions'),
    projections: asArray(source.projections, 'projections'),
    spring_wind: normalizeSpringWind(source.spring_wind),
    consent: { purposes: normalizePurposeConsents(source.consent) },
    calendar_preferences: {
      selected_calendars: asArray(source.calendar_preferences?.selected_calendars ?? source.calendar_preferences?.selected_calendar_ids, 'selected_calendars')
        .map(String),
    },
  };
  assertUnique(state.check_ins, 'id');
  assertUnique(state.advice, 'id');
  assertUnique(state.plans, 'id');
  assertUnique(state.completions, 'id');
  const suggestions = new Set();
  state.advice.forEach(advice => {
    if (!Array.isArray(advice.suggestions)) throw new Error('suggestions 类型无效');
    advice.suggestions.forEach(suggestion => {
      const id = requiredId(suggestion.id, 'suggestion');
      if (suggestions.has(id)) throw new Error(`suggestion 存在重复 ID: ${id}`);
      suggestions.add(id);
      positiveMinutes(suggestion.planned_duration_minutes, 'suggestion');
    });
  });
  state.plans.forEach(plan => {
    requiredId(plan.suggestion_id, 'plan suggestion');
    if (!suggestions.has(String(plan.suggestion_id))) throw new Error(`plan 存在悬空引用: ${plan.suggestion_id}`);
    positiveMinutes(plan.planned_duration_minutes, 'plan');
  });
  state.completions.forEach(completion => {
    requiredId(completion.source_id, 'completion source');
    if (!suggestions.has(String(completion.source_id))) throw new Error(`completion 存在悬空引用: ${completion.source_id}`);
    positiveMinutes(completion.actual_duration_minutes, 'completion');
  });
  return state;
};

export const saveCheckIn = (current, input) => {
  const state = normalizeDailyBalanceState(current);
  const date = String(input?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('签到日期无效');
  for (const field of ['sleep', 'energy', 'mood']) {
    const score = Number(input[field]);
    if (!Number.isFinite(score) || score < 1 || score > 5) throw new Error(`${field} 必须为 1–5`);
  }
  const previous = state.check_ins.find(row => row.date === date);
  const row = {
    id: previous?.id || input.id || makeId('checkin'), date,
    sleep: Number(input.sleep), energy: Number(input.energy), mood: Number(input.mood),
    discomfort: String(input.discomfort || ''), note: String(input.note || ''),
  };
  state.check_ins = [...state.check_ins.filter(item => item.date !== date), row];
  return state;
};

export const storeAdvice = (current, input) => {
  const state = normalizeDailyBalanceState(current);
  const date = String(input?.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('建议日期无效');
  if (!Array.isArray(input.suggestions) || input.suggestions.length === 0) throw new Error('建议不能为空');
  const usedIds = new Set(state.advice.flatMap(row => row.suggestions.map(item => String(item.id))));
  const suggestions = input.suggestions.map(item => ({
    ...clone(item),
    id: usedIds.has(String(item.id || '')) ? makeId('suggestion') : (item.id || makeId('suggestion')),
    planned_duration_minutes: positiveMinutes(item.planned_duration_minutes, 'suggestion'),
  }));
  const confirmedSuggestionIds = new Set(state.plans.map(row => String(row.suggestion_id)));
  state.advice = state.advice.flatMap(row => {
    if (row.date !== date) return [row];
    const confirmed = row.suggestions.filter(item => confirmedSuggestionIds.has(String(item.id)));
    return confirmed.length ? [{ ...row, suggestions: confirmed }] : [];
  });
  state.advice.push({ id: input.id || makeId('advice'), date, suggestions });
  return normalizeDailyBalanceState(state);
};

export const confirmSuggestion = (current, suggestionId, edits = {}) => {
  const state = normalizeDailyBalanceState(current);
  const suggestion = state.advice.flatMap(row => row.suggestions).find(row => String(row.id) === String(suggestionId));
  if (!suggestion) throw new Error('建议不存在');
  if (state.plans.some(row => String(row.suggestion_id) === String(suggestionId))) return state;
  state.plans.push({
    id: edits.id || makeId('plan'), suggestion_id: suggestion.id,
    planned_start: edits.planned_start || suggestion.planned_start || null,
    planned_end: edits.planned_end || suggestion.planned_end || null,
    planned_duration_minutes: positiveMinutes(edits.planned_duration_minutes ?? suggestion.planned_duration_minutes, 'plan'),
    status: 'confirmed',
  });
  return state;
};

export const recordCompletion = (current, input) => {
  const state = normalizeDailyBalanceState(current);
  if (state.completions.some(row => String(row.source_id) === String(input.source_id))) return state;
  const plan = state.plans.find(row => String(row.suggestion_id) === String(input.source_id));
  if (!plan) throw new Error('完成记录引用的计划不存在');
  const actual = positiveMinutes(input.actual_duration_minutes, 'actual');
  state.completions.push({
    id: input.id || makeId('completion'), source_id: plan.suggestion_id,
    actual_start: input.actual_start || null, actual_end: input.actual_end || input.completed_at || null,
    actual_duration_minutes: actual, completed_at: input.completed_at || null,
    feeling: String(input.feeling || ''), variance_minutes: actual - Number(plan.planned_duration_minutes),
    reward_basis: 'actual',
  });
  plan.status = 'completed';
  return state;
};

export const updateProjection = (current, entityId, update) => {
  const state = normalizeDailyBalanceState(current);
  const entity_id = requiredId(entityId, 'projection entity');
  let projection = state.projections.find(row => row.entity_id === entity_id && row.operation_id === update.operation_id);
  if (!projection) {
    projection = { entity_id, operation_id: requiredId(update.operation_id, 'operation'), attempt_id: null, state: 'not_synced', event_id: null };
    state.projections.push(projection);
  }
  if (projection.state === 'succeeded') return state;
  const isNewAttempt = update.state === 'pending' && update.attempt_id && update.attempt_id !== projection.attempt_id;
  if (!isNewAttempt && projection.attempt_id && update.attempt_id !== projection.attempt_id) return state;
  Object.assign(projection, {
    attempt_id: update.attempt_id ?? projection.attempt_id,
    state: update.state || projection.state,
    event_id: update.event_id ?? projection.event_id,
    kind: update.kind ?? projection.kind,
    title: update.title ?? projection.title,
    start: update.start ?? projection.start,
    end: update.end ?? projection.end,
  });
  return state;
};

export const preparePortableDailyBalance = current => {
  const state = normalizeDailyBalanceState(current);
  state.calendar_preferences = { selected_calendars: [] };
  state.consent = { purposes: emptyPurposeConsents() };
  if (state.spring_wind) state.spring_wind.locations = { birth: null, current: null };
  state.projections = state.projections.map(row => ({
    entity_id: row.entity_id, operation_id: row.operation_id,
    attempt_id: null, state: 'not_synced', event_id: null,
    ...(row.kind ? { kind: row.kind } : {}),
    ...(row.title ? { title: row.title } : {}),
    ...(row.start ? { start: row.start } : {}),
    ...(row.end ? { end: row.end } : {}),
  }));
  return state;
};

export const setPurposeConsent = (current, purpose, value) => {
  if (!CONSENT_PURPOSES.includes(purpose)) throw new Error('授权用途无效');
  const state = normalizeDailyBalanceState(current);
  state.consent.purposes[purpose] = value == null ? null : normalizeConsent({ ...value, purpose }, purpose);
  if (value != null && !state.consent.purposes[purpose]) throw new Error('授权内容无效');
  return state;
};
