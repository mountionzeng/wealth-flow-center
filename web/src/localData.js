import {
  createDailyBalanceState,
  normalizeDailyBalanceState,
  saveCheckIn,
  storeAdvice,
  confirmSuggestion,
  recordCompletion,
  updateProjection,
  preparePortableDailyBalance,
  setPurposeConsent,
} from './dailyBalance.js';
import {
  addKnowledgeNote,
  appendKnowledgeAddition,
  createKnowledgeState,
  markKnowledgeNotification,
  normalizeKnowledgeState,
  recordKnowledgeReview,
  removeKnowledgeNote,
  removeObsidianTaskDraft,
  restoreKnowledgeRevision,
  storeObsidianReviewCards,
  upsertObsidianTaskDraft,
  updateKnowledgeNote,
} from './knowledgeData.js';

const ACCOUNT_KEY = 'wealth-center.accounts.v1';
const SESSION_KEY = 'wealth-center.session.v1';
const DATA_PREFIX = 'wealth-center.data.v1.';
const mutationQueues = new Map();

const TYPE_CONFIG = {
  course: { label: '课程学习', xp: 1, wealth: 1 },
  review: { label: '复习巩固', xp: 0.9, wealth: 0.9 },
  skill: { label: '技能拓展', xp: 1.1, wealth: 1.2 },
  practice: { label: '实践', xp: 1.05, wealth: 1.1 },
  knowledge: { label: '知识库搭建', xp: 1, wealth: 1.1 },
  homework: { label: '做作业', xp: 0.95, wealth: 1 },
};

const pad = value => String(value).padStart(2, '0');
const formatTime = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
const dateKey = date => formatTime(date).slice(0, 10);
const parseTime = raw => {
  if (!raw) return null;
  const parsed = new Date(String(raw).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const defaultState = () => ({
  schema_version: 2,
  revision: 0,
  player: { level: 1, xp: 0, wealth: 0, streak: 0, last_completed_date: null, total_done: 0, total_minutes: 0 },
  next_id: 1,
  quests: [],
  daily_balance: createDailyBalanceState(),
  knowledge_base: createKnowledgeState(),
});

const safeJSON = (raw, fallback) => {
  try { return JSON.parse(raw) ?? fallback; } catch { return fallback; }
};

const accountList = storage => {
  const rows = safeJSON(storage.getItem(ACCOUNT_KEY), []);
  return Array.isArray(rows) ? rows : [];
};

const saveAccounts = (storage, accounts) => storage.setItem(ACCOUNT_KEY, JSON.stringify(accounts));
const normalizeUsername = value => String(value || '').trim().toLocaleLowerCase();

const randomHex = bytes => {
  const data = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(data);
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
};

const passwordHash = async (password, salt) => {
  const material = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

export const accountService = {
  list(storage = globalThis.localStorage) {
    return accountList(storage).map(({ password_hash, salt, ...safe }) => safe);
  },

  async register({ username, displayName, password }, storage = globalThis.localStorage) {
    const login = normalizeUsername(username);
    const name = String(displayName || username || '').trim();
    if (login.length < 2 || login.length > 24) throw new Error('请输入 2–24 个字的名字');
    if (/[\u0000-\u001f\u007f]/.test(login)) throw new Error('名字里不能包含特殊控制字符');
    if (String(password || '').length < 4) throw new Error('本机密码至少需要 4 位');
    const accounts = accountList(storage);
    if (accounts.some(account => account.username === login)) throw new Error('这个账号已存在于当前浏览器');
    const salt = randomHex(16);
    const account = {
      id: globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : randomHex(16),
      username: login,
      display_name: name,
      salt,
      password_hash: await passwordHash(password, salt),
      created_at: new Date().toISOString(),
    };
    saveAccounts(storage, [...accounts, account]);
    storage.setItem(`${DATA_PREFIX}${account.id}`, JSON.stringify(defaultState()));
    return { id: account.id, username: account.username, display_name: account.display_name };
  },

  async login({ username, password }, storage = globalThis.localStorage) {
    const login = normalizeUsername(username);
    const account = accountList(storage).find(row => row.username === login);
    if (!account || await passwordHash(password, account.salt) !== account.password_hash) {
      throw new Error('账号或密码不正确');
    }
    return { id: account.id, username: account.username, display_name: account.display_name };
  },

  restore(storage = globalThis.localStorage, legacySession = globalThis.sessionStorage) {
    let id = storage.getItem(SESSION_KEY);
    if (!id && legacySession && legacySession !== storage) {
      id = legacySession.getItem(SESSION_KEY);
      if (id) {
        storage.setItem(SESSION_KEY, id);
        legacySession.removeItem(SESSION_KEY);
      }
    }
    if (!id) return null;
    const account = accountList(storage).find(row => row.id === id);
    if (!account) {
      storage.removeItem(SESSION_KEY);
      legacySession?.removeItem(SESSION_KEY);
      return null;
    }
    return { id: account.id, username: account.username, display_name: account.display_name };
  },

  remember(account, storage = globalThis.localStorage, legacySession = globalThis.sessionStorage) {
    storage.setItem(SESSION_KEY, account.id);
    if (legacySession && legacySession !== storage) legacySession.removeItem(SESSION_KEY);
  },

  logout(storage = globalThis.localStorage, legacySession = globalThis.sessionStorage) {
    storage.removeItem(SESSION_KEY);
    if (legacySession && legacySession !== storage) legacySession.removeItem(SESSION_KEY);
  },
};

const dataKey = accountId => `${DATA_PREFIX}${accountId}`;
const mutationLockName = accountId => `wealth-center.account.${accountId}`;

const withAccountLock = (accountId, lockManager, task) => {
  const name = mutationLockName(accountId);
  if (lockManager?.request) return lockManager.request(name, { mode: 'exclusive' }, task);

  const previous = mutationQueues.get(name) || Promise.resolve();
  const queued = previous.catch(() => {}).then(task);
  mutationQueues.set(name, queued);
  return queued.finally(() => {
    if (mutationQueues.get(name) === queued) mutationQueues.delete(name);
  });
};

const normalizeState = raw => {
  const base = defaultState();
  const source = raw && typeof raw === 'object' ? raw : {};
  const quests = Array.isArray(source.quests) ? source.quests.filter(row => row && row.id != null).map(row => {
    const quest = { ...row };
    const legacy = quest.reward_basis == null;
    quest.planned_duration_minutes = Number(quest.planned_duration_minutes ?? quest.duration_minutes ?? 0);
    if (quest.status === 'done') {
      quest.actual_duration_minutes = Number(quest.actual_duration_minutes ?? quest.duration_minutes ?? 0);
      quest.reward_basis = legacy ? 'legacy_frozen' : quest.reward_basis;
    } else {
      delete quest.actual_duration_minutes;
      quest.reward_basis = quest.reward_basis || 'planned';
    }
    return quest;
  }) : [];
  const player = { ...base.player, ...(source.player && typeof source.player === 'object' ? source.player : {}) };
  return {
    schema_version: 2,
    revision: Math.max(0, Number(source.revision) || 0),
    player,
    quests,
    next_id: Math.max(Number(source.next_id) || 1, ...quests.map(row => Number(row.id) + 1 || 1)),
    daily_balance: normalizeDailyBalanceState(source.daily_balance),
    knowledge_base: normalizeKnowledgeState(source.knowledge_base),
  };
};

const readState = (accountId, storage) => normalizeState(safeJSON(storage.getItem(dataKey(accountId)), defaultState()));
const writeState = (accountId, storage, state) => {
  const next = { ...state, revision: Number(state.revision || 0) + 1 };
  const serialized = JSON.stringify(next);
  storage.setItem(dataKey(accountId), serialized);
  if (storage.getItem(dataKey(accountId)) !== serialized) throw new Error('本地数据保存失败，请重试');
  return next;
};

const rewardFor = (minutes, type) => {
  const config = TYPE_CONFIG[type] || TYPE_CONFIG.course;
  return [Math.max(20, Math.floor(minutes * 0.8 * config.xp)), Math.max(2, Math.floor((minutes / 15) * config.wealth))];
};

const applyLevel = player => {
  while (player.xp >= 100 + (player.level - 1) * 40) {
    player.xp -= 100 + (player.level - 1) * 40;
    player.level += 1;
  }
};

const updateStreak = (player, completed) => {
  const today = dateKey(completed);
  const yesterday = new Date(completed);
  yesterday.setDate(yesterday.getDate() - 1);
  if (player.last_completed_date === today) return;
  player.streak = player.last_completed_date === dateKey(yesterday) ? Number(player.streak || 0) + 1 : 1;
  player.last_completed_date = today;
};

const rebuildPlayer = state => {
  const player = defaultState().player;
  const done = state.quests
    .filter(row => row.status === 'done')
    .sort((a, b) => String(a.completed_at || a.end || '').localeCompare(String(b.completed_at || b.end || '')));
  done.forEach(quest => {
    const actual = Number(quest.actual_duration_minutes ?? quest.duration_minutes ?? 0);
    const [xp, wealth] = rewardFor(actual, quest.task_type);
    if (quest.reward_basis !== 'legacy_frozen') {
      quest.reward_xp = xp;
      quest.reward_wealth = wealth;
      quest.reward_basis = 'actual';
    } else {
      quest.reward_xp = Number(quest.reward_xp) || xp;
      quest.reward_wealth = Number(quest.reward_wealth) || wealth;
    }
    player.xp += quest.reward_xp;
    player.wealth += quest.reward_wealth;
    player.total_done += 1;
    player.total_minutes += actual;
    updateStreak(player, parseTime(quest.completed_at || quest.end) || new Date());
    applyLevel(player);
  });
  state.player = player;
};

const dashboard = state => {
  const now = new Date();
  const days = [];
  const dayTotals = {};
  for (let index = 29; index >= 0; index -= 1) {
    const day = new Date(now);
    day.setDate(day.getDate() - index);
    const key = dateKey(day);
    days.push(key);
    dayTotals[key] = 0;
  }
  const typeMinutes = Object.fromEntries(Object.keys(TYPE_CONFIG).map(type => [type, 0]));
  const courseTotals = new Map();
  state.quests.filter(row => row.status === 'done').forEach(quest => {
    const minutes = Number(quest.actual_duration_minutes ?? quest.duration_minutes ?? 0);
    const when = parseTime(quest.start || quest.end || quest.completed_at);
    const key = when ? dateKey(when) : '';
    if (Object.hasOwn(dayTotals, key)) dayTotals[key] += minutes;
    typeMinutes[quest.task_type] = Number(typeMinutes[quest.task_type] || 0) + minutes;
    if (Object.hasOwn(dayTotals, key)) {
      const course = String(quest.course_name || quest.title || '未命名课程').trim();
      const current = courseTotals.get(course) || { course_name: course, minutes: 0, sessions: 0 };
      current.minutes += minutes;
      current.sessions += 1;
      courseTotals.set(course, current);
    }
  });

  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weeklyOutline = weekdays.map((weekday, index) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + index);
    const key = dateKey(day);
    const tasks = state.quests.filter(quest => String(quest.start || '').slice(0, 10) === key).sort((a, b) => String(a.start).localeCompare(String(b.start)));
    return { date: key, weekday, is_today: key === dateKey(now), tasks };
  });

  return {
    schema_version: state.schema_version,
    server_time: formatTime(now),
    player: { ...state.player, xp_target: 100 + (Number(state.player.level || 1) - 1) * 40 },
    quests: [...state.quests].sort((a, b) => String(b.start || '').localeCompare(String(a.start || ''))).map(quest => ({
      ...quest,
      label: `${TYPE_CONFIG[quest.task_type]?.label || TYPE_CONFIG.course.label} | ${quest.course_name ? `${quest.course_name} | ` : ''}${quest.title}`,
    })),
    charts: {
      days,
      day_minutes: days.map(day => dayTotals[day]),
      type_minutes: typeMinutes,
      course_minutes: [...courseTotals.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 10),
    },
    weekly_outline: weeklyOutline,
    weekly: null,
    reminders: [],
  };
};

export const createLocalAPI = (accountId, storage = globalThis.localStorage, lockManager = globalThis.navigator?.locks) => ({
  async state() {
    return { ok: true, data: dashboard(readState(accountId, storage)) };
  },

  async addQ(body) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      const start = parseTime(body.start);
      const end = parseTime(body.end);
      if (!start || !end || end <= start) throw new Error('结束时间必须晚于开始时间');
      const title = String(body.title || '').trim();
      if (!title) throw new Error('请输入任务标题');
      const minutes = Math.max(10, Math.floor((end - start) / 60000));
      const type = TYPE_CONFIG[body.task_type] ? body.task_type : 'course';
      const [xp, wealth] = rewardFor(minutes, type);
      const quest = {
        id: state.next_id++, title, task_type: type, course_name: String(body.course_name || '').trim(),
        start: formatTime(start), end: formatTime(end), duration_minutes: minutes,
        planned_start: formatTime(start), planned_end: formatTime(end), planned_duration_minutes: minutes,
        reward_xp: xp, reward_wealth: wealth, status: 'todo', created_at: formatTime(new Date()), completed_at: null,
        reward_basis: 'planned',
        calendar_sync_status: body.write_calendar ? 'pending' : 'skipped',
        calendar_sync_message: body.write_calendar ? '已确认时间，等待写入 Berich · 计划' : '未选择写入日历',
      };
      state.quests.push(quest);
      writeState(accountId, storage, state);
      return { ok: true, quest: structuredClone(quest) };
    });
  },

  async updateQuestCalendar(id, update = {}) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      const quest = state.quests.find(row => Number(row.id) === Number(id));
      if (!quest) throw new Error('任务不存在');
      const status = ['pending', 'syncing', 'done', 'failed', 'skipped'].includes(update.status) ? update.status : 'failed';
      quest.calendar_sync_status = status;
      quest.calendar_sync_message = String(update.message || '').trim().slice(0, 240);
      quest.calendar_operation_id = String(update.operation_id || quest.calendar_operation_id || '').trim().slice(0, 160);
      quest.calendar_event_id = String(update.event_id || quest.calendar_event_id || '').trim().slice(0, 240) || null;
      quest.updated_at = formatTime(new Date());
      writeState(accountId, storage, state);
      return { ok: true, quest: structuredClone(quest) };
    });
  },

  async editQ(id, body) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      const quest = state.quests.find(row => Number(row.id) === Number(id));
      if (!quest) throw new Error('任务不存在');
      const start = parseTime(body.start);
      const end = parseTime(body.end);
      if (!start || !end || end <= start) throw new Error('结束时间必须晚于开始时间');
      const minutes = Math.max(10, Math.floor((end - start) / 60000));
      const type = TYPE_CONFIG[body.task_type] ? body.task_type : 'course';
      const [xp, wealth] = rewardFor(minutes, type);
      Object.assign(quest, { title: String(body.title || '').trim(), task_type: type, course_name: String(body.course_name || '').trim(), start: formatTime(start), end: formatTime(end), duration_minutes: minutes, planned_start: formatTime(start), planned_end: formatTime(end), planned_duration_minutes: minutes, reward_xp: xp, reward_wealth: wealth, updated_at: formatTime(new Date()) });
      if (!quest.title) throw new Error('请输入任务标题');
      if (quest.status === 'done') rebuildPlayer(state);
      writeState(accountId, storage, state);
      return { ok: true };
    });
  },

  async delQ(id) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      const before = state.quests.length;
      state.quests = state.quests.filter(row => Number(row.id) !== Number(id));
      if (state.quests.length === before) throw new Error('任务不存在');
      rebuildPlayer(state);
      writeState(accountId, storage, state);
      return { ok: true };
    });
  },

  async complQ(id, details = {}) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      const quest = state.quests.find(row => Number(row.id) === Number(id));
      if (!quest) throw new Error('任务不存在');
      if (quest.status !== 'done') {
        const actualMinutes = Number(details.actual_duration_minutes ?? quest.planned_duration_minutes ?? quest.duration_minutes);
        if (!Number.isFinite(actualMinutes) || actualMinutes < 1 || actualMinutes > 720) throw new Error('实际时长请输入 1–720 分钟');
        const feeling = String(details.feeling ?? '已完成').trim();
        if (!feeling) throw new Error('请写一句真实感受');
        quest.status = 'done';
        quest.completed_at = formatTime(new Date());
        quest.actual_duration_minutes = Math.round(actualMinutes);
        quest.actual_end = details.actual_end || quest.completed_at;
        quest.actual_start = details.actual_start || null;
        quest.feeling = feeling.slice(0, 160);
        quest.variance_minutes = quest.actual_duration_minutes - Number(quest.planned_duration_minutes ?? quest.duration_minutes ?? 0);
        quest.reward_basis = 'actual';
        rebuildPlayer(state);
        writeState(accountId, storage, state);
      }
      return { ok: true };
    });
  },

  knowledgeState() {
    return normalizeKnowledgeState(readState(accountId, storage).knowledge_base);
  },

  async createKnowledgeNote(input) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = addKnowledgeNote(state.knowledge_base, input);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async updateKnowledgeNote(id, input) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = updateKnowledgeNote(state.knowledge_base, id, input);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async appendKnowledgeAddition(id, input) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = appendKnowledgeAddition(state.knowledge_base, id, input);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async restoreKnowledgeRevision(id, revisionIndex) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = restoreKnowledgeRevision(state.knowledge_base, id, revisionIndex);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async deleteKnowledgeNote(id) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = removeKnowledgeNote(state.knowledge_base, id);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async recordKnowledgeReview(id, grade) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = recordKnowledgeReview(state.knowledge_base, id, grade);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async markKnowledgeNotification(date) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = markKnowledgeNotification(state.knowledge_base, date);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async storeObsidianReviewCards(input) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = storeObsidianReviewCards(state.knowledge_base, input);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async upsertObsidianTaskDraft(input) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = upsertObsidianTaskDraft(state.knowledge_base, input);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  async removeObsidianTaskDraft(sourceKey) {
    return withAccountLock(accountId, lockManager, () => {
      const state = readState(accountId, storage);
      state.knowledge_base = removeObsidianTaskDraft(state.knowledge_base, sourceKey);
      return normalizeKnowledgeState(writeState(accountId, storage, state).knowledge_base);
    });
  },

  exportData() {
    return JSON.stringify(readState(accountId, storage), null, 2);
  },

  async importData(raw) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const candidate = parsed?.data || parsed;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('备份格式无效');
    if (candidate.quests != null && !Array.isArray(candidate.quests)) throw new Error('quests 类型无效');
    const questIds = new Set();
    for (const quest of candidate.quests || []) {
      if (quest?.id == null || questIds.has(String(quest.id))) throw new Error('quest 存在重复或无效 ID');
      questIds.add(String(quest.id));
    }
    const state = normalizeState(candidate);
    state.daily_balance = preparePortableDailyBalance(state.daily_balance);
    rebuildPlayer(state);
    return withAccountLock(accountId, lockManager, () => writeState(accountId, storage, state));
  },
});

export const createDailyBalanceAPI = (accountId, storage = globalThis.localStorage, lockManager = globalThis.navigator?.locks) => {
  const mutate = reducer => withAccountLock(accountId, lockManager, () => {
    const account = readState(accountId, storage);
    account.daily_balance = reducer(account.daily_balance);
    const saved = writeState(accountId, storage, account);
    return normalizeDailyBalanceState(saved.daily_balance);
  });
  return {
    state: () => normalizeDailyBalanceState(readState(accountId, storage).daily_balance),
    saveCheckIn: input => mutate(state => saveCheckIn(state, input)),
    storeAdvice: input => mutate(state => storeAdvice(state, input)),
    confirmSuggestion: (id, edits) => mutate(state => confirmSuggestion(state, id, edits)),
    recordCompletion: input => mutate(state => recordCompletion(state, input)),
    updateProjection: (entityId, update) => mutate(state => updateProjection(state, entityId, update)),
    saveSpringWind: value => mutate(state => ({ ...state, spring_wind: value == null ? null : structuredClone(value) })),
    saveSpringWindProfile: profile => mutate(state => ({
      ...state,
      spring_wind: {
        ...(state.spring_wind && typeof state.spring_wind === 'object' ? state.spring_wind : {}),
        profile: {
          ...(state.spring_wind?.profile && typeof state.spring_wind.profile === 'object' ? state.spring_wind.profile : {}),
          ...structuredClone(profile || {}),
        },
      },
    })),
    saveSpringWindLocations: locations => mutate(state => ({
      ...state,
      spring_wind: {
        ...(state.spring_wind && typeof state.spring_wind === 'object' ? state.spring_wind : {}),
        locations: {
          birth: locations && Object.hasOwn(locations, 'birth') ? locations.birth : state.spring_wind?.locations?.birth ?? null,
          current: locations && Object.hasOwn(locations, 'current') ? locations.current : state.spring_wind?.locations?.current ?? null,
        },
      },
    })),
    setConsent: (purpose, value) => mutate(state => setPurposeConsent(state, purpose, value)),
    setCalendarPreferences: value => mutate(state => ({ ...state, calendar_preferences: { selected_calendars: Array.isArray(value?.selected_calendars) ? value.selected_calendars.map(String) : [] } })),
  };
};

export const localDataKeys = { ACCOUNT_KEY, SESSION_KEY, DATA_PREFIX };
