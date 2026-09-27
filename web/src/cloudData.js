import { normalizeDailyBalanceState, preparePortableDailyBalance } from './dailyBalance.js';
import { normalizeKnowledgeState } from './knowledgeData.js';
import { normalizeWorkState } from './workData.js';

export const CLOUD_SCHEMA_VERSION = 1;

const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const requiredCloudKeys = ['schema_version', 'player', 'next_id', 'quests', 'daily_balance', 'knowledge_base'];
const allowedCloudKeys = new Set([...requiredCloudKeys, 'work_base']);

const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
};

export const canonicalCloudJSON = snapshot => JSON.stringify(stableValue(validateCloudSnapshot(snapshot)));

export const cloudContentHash = async snapshot => {
  const bytes = new TextEncoder().encode(canonicalCloudJSON(snapshot));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
};

const portableKnowledge = raw => {
  const knowledge = normalizeKnowledgeState(raw);
  return {
    ...knowledge,
    notes: knowledge.notes.map(note => ({
      ...note,
      sources: note.sources.map(source => ({ ...source, link: '' })),
      review_cards: note.review_cards.map(card => ({ ...card, source_link: '' })),
    })),
    task_drafts: [],
  };
};

const knowledgeOverlay = raw => {
  const knowledge = normalizeKnowledgeState(raw);
  return {
    task_drafts: clone(knowledge.task_drafts),
    links: Object.fromEntries(knowledge.notes.map(note => [String(note.id), {
      sources: Object.fromEntries(note.sources.map(source => [String(source.id), source.link])),
      cards: Object.fromEntries(note.review_cards.map(card => [String(card.id), card.source_link])),
    }])),
  };
};

const dailyOverlay = raw => {
  const daily = normalizeDailyBalanceState(raw);
  return {
    projections: clone(daily.projections),
    calendar_preferences: clone(daily.calendar_preferences),
    consent: clone(daily.consent),
    spring_wind_locations: clone(daily.spring_wind?.locations || { birth: null, current: null }),
  };
};

export const splitAccountState = raw => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const daily = preparePortableDailyBalance(source.daily_balance);
  daily.projections = [];
  const snapshot = {
    schema_version: CLOUD_SCHEMA_VERSION,
    player: clone(source.player && typeof source.player === 'object' ? source.player : {}),
    next_id: Math.max(1, Number(source.next_id) || 1),
    quests: Array.isArray(source.quests) ? clone(source.quests) : [],
    daily_balance: daily,
    knowledge_base: portableKnowledge(source.knowledge_base),
    work_base: normalizeWorkState(source.work_base),
  };
  return {
    snapshot: validateCloudSnapshot(snapshot),
    overlay: {
      daily_balance: dailyOverlay(source.daily_balance),
      knowledge: knowledgeOverlay(source.knowledge_base),
    },
  };
};

export const validateCloudSnapshot = raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('云端资料无效');
  if (Number(raw.schema_version) !== CLOUD_SCHEMA_VERSION) throw new Error('云端资料版本不受支持');
  if (Object.keys(raw).some(key => !allowedCloudKeys.has(key)) || requiredCloudKeys.some(key => !Object.hasOwn(raw, key))) {
    throw new Error('云端资料字段无效');
  }
  if (!raw.player || typeof raw.player !== 'object' || Array.isArray(raw.player) || !Array.isArray(raw.quests)) {
    throw new Error('云端资料结构无效');
  }
  const daily = normalizeDailyBalanceState(raw.daily_balance);
  const knowledge = normalizeKnowledgeState(raw.knowledge_base);
  const work = normalizeWorkState(raw.work_base);
  if (daily.projections.length || daily.calendar_preferences.selected_calendars.length || Object.values(daily.consent.purposes).some(Boolean)) {
    throw new Error('云端资料不能包含设备连接信息');
  }
  if (daily.spring_wind?.locations?.birth || daily.spring_wind?.locations?.current) {
    throw new Error('云端资料不能包含地点服务标识');
  }
  if (knowledge.task_drafts.length || knowledge.notes.some(note => note.sources.some(source => source.link) || note.review_cards.some(card => card.source_link))) {
    throw new Error('云端资料不能包含 Obsidian 本机链接');
  }
  return {
    schema_version: CLOUD_SCHEMA_VERSION,
    player: clone(raw.player),
    next_id: Math.max(1, Number(raw.next_id) || 1),
    quests: clone(raw.quests),
    daily_balance: daily,
    knowledge_base: knowledge,
    work_base: work,
  };
};

export const mergeCloudSnapshot = (rawSnapshot, rawOverlay = {}) => {
  const snapshot = validateCloudSnapshot(rawSnapshot);
  const overlay = rawOverlay && typeof rawOverlay === 'object' ? rawOverlay : {};
  const daily = normalizeDailyBalanceState(snapshot.daily_balance);
  const dailyDevice = overlay.daily_balance && typeof overlay.daily_balance === 'object' ? overlay.daily_balance : {};
  daily.projections = Array.isArray(dailyDevice.projections) ? clone(dailyDevice.projections) : [];
  daily.calendar_preferences = dailyDevice.calendar_preferences && typeof dailyDevice.calendar_preferences === 'object'
    ? clone(dailyDevice.calendar_preferences)
    : { selected_calendars: [] };
  daily.consent = dailyDevice.consent && typeof dailyDevice.consent === 'object'
    ? clone(dailyDevice.consent)
    : { purposes: {} };
  if (daily.spring_wind) {
    daily.spring_wind.locations = clone(dailyDevice.spring_wind_locations || { birth: null, current: null });
  }

  const knowledge = normalizeKnowledgeState(snapshot.knowledge_base);
  const knowledgeDevice = overlay.knowledge && typeof overlay.knowledge === 'object' ? overlay.knowledge : {};
  const links = knowledgeDevice.links && typeof knowledgeDevice.links === 'object' ? knowledgeDevice.links : {};
  knowledge.notes.forEach(note => {
    const noteLinks = links[String(note.id)] || {};
    note.sources.forEach(source => { source.link = String(noteLinks.sources?.[String(source.id)] || ''); });
    note.review_cards.forEach(card => { card.source_link = String(noteLinks.cards?.[String(card.id)] || ''); });
  });
  knowledge.task_drafts = normalizeKnowledgeState({ task_drafts: knowledgeDevice.task_drafts }).task_drafts;

  return {
    schema_version: 2,
    revision: 0,
    player: clone(snapshot.player),
    next_id: snapshot.next_id,
    quests: clone(snapshot.quests),
    daily_balance: normalizeDailyBalanceState(daily),
    knowledge_base: normalizeKnowledgeState(knowledge),
    work_base: normalizeWorkState(snapshot.work_base),
  };
};
