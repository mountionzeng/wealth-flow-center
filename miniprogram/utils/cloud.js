const { TASK_TYPES, calcRewards } = require('./constants');
const { diffMinutes, questStatus, uuid } = require('./time');

const LOCAL_STATE_KEY = 'studyApi.localState.v1';
const MAX_TITLE_LENGTH = 60;
const MAX_COURSE_LENGTH = 40;
const MAX_DURATION_MINUTES = 24 * 60;

let preferLocalFallback = false;

function friendlyCloudError(error) {
  const raw = `${error?.errCode || ''} ${error?.errMsg || ''} ${error?.message || ''}`;
  if (raw.includes('-601034') || raw.includes('没有权限')) {
    return '云开发未开通，或云函数还没部署';
  }
  if (raw.includes('FUNCTION_NOT_FOUND') || raw.includes('function not found') || raw.includes('云函数不存在')) {
    return '云函数 studyApi 还没部署';
  }
  if (raw.includes('collection') || raw.includes('study_data')) {
    return '云数据库 study_data 未创建';
  }
  return error?.message || error?.errMsg || '云服务请求失败';
}

function canUseLocalFallback(error) {
  const msg = friendlyCloudError(error);
  return msg.includes('云开发未开通') || msg.includes('云函数') || msg.includes('study_data');
}

function xpToNextLevel(level) {
  return 100 + (level - 1) * 40;
}

function applyLevelUp(player) {
  while (player.xp >= xpToNextLevel(player.level)) {
    player.xp -= xpToNextLevel(player.level);
    player.level += 1;
  }
  player.xp_target = xpToNextLevel(player.level);
  return player;
}

function initialState() {
  return {
    player: { level: 1, xp: 0, xp_target: 100, wealth: 0, streak: 0, total_done: 0, total_minutes: 0 },
    quests: [],
    tags: [],
  };
}

function loadLocalState() {
  const state = wx.getStorageSync(LOCAL_STATE_KEY);
  return state && typeof state === 'object' ? state : initialState();
}

function saveLocalState(state) {
  wx.setStorageSync(LOCAL_STATE_KEY, state);
}

function isValidDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return false;
  return !Number.isNaN(new Date(value.replace(' ', 'T')).getTime());
}

function normalizeTaskType(taskType) {
  return TASK_TYPES[taskType] ? taskType : 'course';
}

function normalizeQuestInput(data) {
  const title = String(data.title || '').trim().slice(0, MAX_TITLE_LENGTH);
  const task_type = normalizeTaskType(data.task_type);
  const course_name = String(data.course_name || '').trim().slice(0, MAX_COURSE_LENGTH);
  const { start, end } = data;
  if (!title) return { ok: false, error: '请填写任务名称' };
  if (!isValidDateTime(start) || !isValidDateTime(end)) return { ok: false, error: '时间格式不正确' };

  const duration_minutes = diffMinutes(start, end);
  if (duration_minutes <= 0) return { ok: false, error: '结束时间必须晚于开始时间' };
  if (duration_minutes > MAX_DURATION_MINUTES) return { ok: false, error: '单个任务不能超过24小时' };

  return { ok: true, title, task_type, course_name, start, end, duration_minutes };
}

function rewardFields(durationMinutes, taskType) {
  const reward = calcRewards(durationMinutes, taskType);
  return { reward_xp: reward.xp, reward_wealth: reward.wealth };
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function buildCharts(quests) {
  const now = new Date();
  const days = [];
  const day_minutes = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = dateKey(d);
    days.push(ds);
    day_minutes.push(quests
      .filter(q => q.completed_at && q.start && q.start.startsWith(ds))
      .reduce((sum, q) => sum + (q.duration_minutes || 0), 0));
  }

  const type_minutes = {};
  const course_minutes = {};
  quests.filter(q => q.completed_at).forEach(q => {
    const type = q.task_type || 'course';
    type_minutes[type] = (type_minutes[type] || 0) + (q.duration_minutes || 0);
    if (q.course_name) {
      course_minutes[q.course_name] = (course_minutes[q.course_name] || 0) + (q.duration_minutes || 0);
    }
  });

  return { days, day_minutes, type_minutes, course_minutes };
}

function buildWeekly(quests) {
  const dayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());

  const weekly = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const ds = dateKey(d);
    weekly[dayNames[d.getDay()]] = {
      date: ds,
      tasks: quests
        .filter(q => q.start && q.start.startsWith(ds))
        .sort((a, b) => a.start.localeCompare(b.start)),
    };
  }
  return weekly;
}

function calcStreak(quests) {
  const doneDates = new Set(
    quests
      .filter(q => q.completed_at)
      .map(q => (q.start || '').slice(0, 10))
      .filter(Boolean)
  );
  const now = new Date();
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    if (doneDates.has(dateKey(d))) streak++;
    else if (i > 0) break;
  }
  return streak;
}

function getLocalState() {
  const state = loadLocalState();
  const quests = (state.quests || []).map(q => ({ ...q, status: questStatus(q) }));
  const level = state.player?.level || 1;
  const player = {
    ...(state.player || {}),
    level,
    xp_target: xpToNextLevel(level),
    streak: calcStreak(quests),
  };
  const result = {
    ok: true,
    player,
    quests,
    tags: state.tags || [],
    charts: buildCharts(quests),
    weekly: buildWeekly(quests),
    localFallback: true,
  };
  saveLocalState({ ...state, player });
  return result;
}

function addLocalQuest(data) {
  const state = loadLocalState();
  const input = normalizeQuestInput(data);
  if (!input.ok) return input;

  const quest = {
    id: uuid(),
    title: input.title,
    task_type: input.task_type,
    course_name: input.course_name || '',
    start: input.start,
    end: input.end,
    duration_minutes: input.duration_minutes,
    ...rewardFields(input.duration_minutes, input.task_type),
    status: 'upcoming',
    completed_at: null,
    calendar_sync_status: 'none',
  };
  saveLocalState({ ...state, quests: [...(state.quests || []), quest] });
  return { ok: true, quest, localFallback: true };
}

function editLocalQuest(data) {
  const state = loadLocalState();
  if (!data.id) return { ok: false, error: '缺少任务ID' };
  const input = normalizeQuestInput(data);
  if (!input.ok) return input;

  let found = false;
  const quests = (state.quests || []).map(q => {
    if (q.id !== data.id) return q;
    found = true;
    return {
      ...q,
      title: input.title,
      task_type: input.task_type,
      course_name: input.course_name || '',
      start: input.start,
      end: input.end,
      duration_minutes: input.duration_minutes,
      ...rewardFields(input.duration_minutes, input.task_type),
    };
  });
  if (!found) return { ok: false, error: '任务不存在' };
  saveLocalState({ ...state, quests });
  return { ok: true, localFallback: true };
}

function deleteLocalQuest(data) {
  const state = loadLocalState();
  if (!data.id) return { ok: false, error: '缺少任务ID' };
  const quests = (state.quests || []).filter(q => q.id !== data.id);
  if (quests.length === (state.quests || []).length) return { ok: false, error: '任务不存在' };
  saveLocalState({ ...state, quests });
  return { ok: true, localFallback: true };
}

function completeLocalQuest(data) {
  const state = loadLocalState();
  if (!data.id) return { ok: false, error: '缺少任务ID' };
  const target = (state.quests || []).find(q => q.id === data.id);
  if (!target) return { ok: false, error: '任务不存在' };
  if (target.completed_at) return { ok: false, error: '任务已完成' };

  let earnedXp = 0;
  let earnedWealth = 0;
  let earnedMinutes = 0;
  const quests = (state.quests || []).map(q => {
    if (q.id !== data.id || q.completed_at) return q;
    earnedXp = q.reward_xp || 0;
    earnedWealth = q.reward_wealth || 0;
    earnedMinutes = q.duration_minutes || 0;
    return { ...q, completed_at: new Date().toISOString(), status: 'done' };
  });

  const oldPlayer = state.player || {};
  const player = applyLevelUp({
    ...oldPlayer,
    level: oldPlayer.level || 1,
    xp: (oldPlayer.xp || 0) + earnedXp,
    wealth: (oldPlayer.wealth || 0) + earnedWealth,
    total_done: (oldPlayer.total_done || 0) + 1,
    total_minutes: (oldPlayer.total_minutes || 0) + earnedMinutes,
  });

  const completedQuest = quests.find(q => q.id === data.id);
  let tags = state.tags || [];
  if (completedQuest && completedQuest.title) {
    const existIdx = tags.findIndex(t => t.title === completedQuest.title && t.task_type === completedQuest.task_type);
    if (existIdx >= 0) {
      tags = tags.map((t, i) => i === existIdx
        ? { ...t, uses: (t.uses || 0) + 1, duration_minutes: completedQuest.duration_minutes }
        : t);
    } else if (tags.length < 20) {
      tags = [...tags, {
        id: uuid(),
        title: completedQuest.title,
        task_type: completedQuest.task_type,
        course_name: completedQuest.course_name || '',
        duration_minutes: completedQuest.duration_minutes || 0,
        uses: 1,
      }];
    }
  }

  saveLocalState({ ...state, quests, player, tags });
  return { ok: true, earned: { xp: earnedXp, wealth: earnedWealth }, player, localFallback: true };
}

function useLocalTag(data) {
  const state = loadLocalState();
  const tag = (state.tags || []).find(t => t.id === data.tag_id);
  if (!tag) return { ok: false, error: '标签不存在' };
  if (!isValidDateTime(data.start)) return { ok: false, error: '时间格式不正确' };
  if (!tag.duration_minutes || tag.duration_minutes <= 0 || tag.duration_minutes > MAX_DURATION_MINUTES) {
    return { ok: false, error: '标签时长不正确' };
  }

  const startDate = new Date(data.start.replace(' ', 'T'));
  const endDate = new Date(startDate.getTime() + tag.duration_minutes * 60000);
  const end = `${dateKey(endDate)} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;
  const quest = {
    id: uuid(),
    title: tag.title,
    task_type: normalizeTaskType(tag.task_type),
    course_name: tag.course_name || '',
    start: data.start,
    end,
    duration_minutes: tag.duration_minutes,
    ...rewardFields(tag.duration_minutes, tag.task_type),
    status: 'upcoming',
    completed_at: null,
    calendar_sync_status: 'none',
  };
  const tags = (state.tags || []).map(t => t.id === data.tag_id ? { ...t, uses: (t.uses || 0) + 1 } : t);
  saveLocalState({ ...state, quests: [...(state.quests || []), quest], tags });
  return { ok: true, quest, localFallback: true };
}

function callLocalStudyApi(action, data = {}) {
  switch (action) {
    case 'getState': return getLocalState();
    case 'addQuest': return addLocalQuest(data);
    case 'editQuest': return editLocalQuest(data);
    case 'deleteQuest': return deleteLocalQuest(data);
    case 'completeQuest': return completeLocalQuest(data);
    case 'useTag': return useLocalTag(data);
    default: return { ok: false, error: `未知操作: ${action}` };
  }
}

async function callStudyApi(action, data = {}) {
  if (preferLocalFallback) {
    const result = callLocalStudyApi(action, data);
    if (!result.ok) throw new Error(result.error || '操作失败');
    return result;
  }

  try {
    const res = await wx.cloud.callFunction({
      name: 'studyApi',
      data: { action, data },
    });
    const result = res.result || {};
    if (!result.ok) throw new Error(result.error || '操作失败');
    return result;
  } catch (error) {
    if (canUseLocalFallback(error)) {
      preferLocalFallback = true;
      const result = callLocalStudyApi(action, data);
      if (!result.ok) throw new Error(result.error || '操作失败');
      return result;
    }
    throw new Error(friendlyCloudError(error));
  }
}

module.exports = { callStudyApi, friendlyCloudError };
