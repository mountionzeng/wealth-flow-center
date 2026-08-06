const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ── 任务类型配置 ───────────────────────────────────────
const TASK_TYPES = {
  course:    { label: '课程学习', xp_mult: 1.0,  wealth_mult: 1.0  },
  review:    { label: '复习巩固', xp_mult: 0.9,  wealth_mult: 0.9  },
  skill:     { label: '技能拓展', xp_mult: 1.1,  wealth_mult: 1.2  },
  practice:  { label: '实践',    xp_mult: 1.05, wealth_mult: 1.1  },
  knowledge: { label: '知识库搭建', xp_mult: 1.0, wealth_mult: 1.1 },
  homework:  { label: '做作业', xp_mult: 0.95, wealth_mult: 1.0  },
};
const MAX_TITLE_LENGTH = 60;
const MAX_COURSE_LENGTH = 40;
const MAX_DURATION_MINUTES = 24 * 60;

function calcRewards(durationMinutes, taskType) {
  const tc = TASK_TYPES[taskType] || TASK_TYPES.course;
  return {
    reward_xp: Math.max(20, Math.floor(durationMinutes * 0.8 * tc.xp_mult)),
    reward_wealth: Math.max(2, Math.floor((durationMinutes / 15) * tc.wealth_mult)),
  };
}

// ── UUID ──────────────────────────────────────────────
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── 时间工具 ──────────────────────────────────────────
function diffMinutes(s, e) {
  if (!s || !e) return 0;
  return Math.max(0, Math.round((new Date(e.replace(' ', 'T')) - new Date(s.replace(' ', 'T'))) / 60000));
}

function questStatus(q) {
  if (q.completed_at) return 'done';
  if (!q.start || !q.end) return 'upcoming';
  const now = Date.now();
  const st = new Date(q.start.replace(' ', 'T')).getTime();
  const en = new Date(q.end.replace(' ', 'T')).getTime();
  if (now < st) return 'upcoming';
  if (now <= en) return 'active';
  return 'overdue';
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

// ── XP 升级计算 ────────────────────────────────────────
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

// ── 图表数据计算 ───────────────────────────────────────
function buildCharts(quests) {
  const now = new Date();
  const days = [], day_minutes = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    days.push(ds);
    const mins = quests
      .filter(q => q.completed_at && q.start && q.start.startsWith(ds))
      .reduce((s, q) => s + (q.duration_minutes || 0), 0);
    day_minutes.push(mins);
  }

  const type_minutes = {};
  const course_minutes = {};
  quests.filter(q => q.completed_at).forEach(q => {
    const t = q.task_type || 'course';
    type_minutes[t] = (type_minutes[t] || 0) + (q.duration_minutes || 0);
    if (q.course_name) {
      course_minutes[q.course_name] = (course_minutes[q.course_name] || 0) + (q.duration_minutes || 0);
    }
  });

  return { days, day_minutes, type_minutes, course_minutes };
}

// ── 本周大纲 ──────────────────────────────────────────
function buildWeekly(quests) {
  const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());

  const weekly = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dayName = DAY_NAMES[d.getDay()];
    const tasks = quests
      .filter(q => q.start && q.start.startsWith(ds))
      .sort((a, b) => a.start.localeCompare(b.start));
    weekly[dayName] = { date: ds, tasks };
  }
  return weekly;
}

// ── 连续学习天数计算 ───────────────────────────────────
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
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (doneDates.has(ds)) streak++;
    else if (i > 0) break;
  }
  return streak;
}

// ── 获取或初始化用户数据 ────────────────────────────────
async function getUserDoc(openid) {
  const res = await db.collection('study_data')
    .where({ _openid: openid })
    .limit(1)
    .get();

  if (res.data.length > 0) return res.data[0];

  // 首次使用，初始化
  const initData = {
    _openid: openid,
    player: { level: 1, xp: 0, xp_target: 100, wealth: 0, streak: 0, total_done: 0, total_minutes: 0 },
    quests: [],
    tags: [],
  };
  const addRes = await db.collection('study_data').add({ data: initData });
  return { ...initData, _id: addRes._id };
}

// ── 更新用户文档 ──────────────────────────────────────
async function updateUserDoc(docId, data) {
  await db.collection('study_data').doc(docId).update({ data });
}

// ── Actions ───────────────────────────────────────────

async function getState(openid) {
  const doc = await getUserDoc(openid);
  const quests = (doc.quests || []).map(q => ({ ...q, status: questStatus(q) }));
  const charts = buildCharts(quests);
  const weekly = buildWeekly(quests);
  const streak = calcStreak(quests);
  const level = doc.player?.level || 1;
  const player = { ...(doc.player || {}), level, xp_target: xpToNextLevel(level), streak };
  return { ok: true, player, quests, tags: doc.tags || [], charts, weekly };
}

async function addQuest(openid, data) {
  const doc = await getUserDoc(openid);
  const input = normalizeQuestInput(data);
  if (!input.ok) return input;

  const { title, task_type, course_name, start, end, duration_minutes } = input;
  const rewards = calcRewards(duration_minutes, task_type);
  const quest = {
    id: uuid(),
    title,
    task_type: task_type || 'course',
    course_name: course_name || '',
    start,
    end,
    duration_minutes,
    ...rewards,
    status: 'upcoming',
    completed_at: null,
    calendar_sync_status: 'none',
  };
  const quests = [...(doc.quests || []), quest];
  await updateUserDoc(doc._id, { quests });
  return { ok: true, quest };
}

async function editQuest(openid, data) {
  const doc = await getUserDoc(openid);
  if (!data.id) return { ok: false, error: '缺少任务ID' };

  const input = normalizeQuestInput(data);
  if (!input.ok) return input;

  const { id } = data;
  const { title, task_type, course_name, start, end, duration_minutes } = input;
  const rewards = calcRewards(duration_minutes, task_type);
  let found = false;
  const quests = (doc.quests || []).map(q => {
    if (q.id !== id) return q;
    found = true;
    return { ...q, title, task_type, course_name: course_name || '', start, end, duration_minutes, ...rewards };
  });
  if (!found) return { ok: false, error: '任务不存在' };

  await updateUserDoc(doc._id, { quests });
  return { ok: true };
}

async function deleteQuest(openid, data) {
  const doc = await getUserDoc(openid);
  if (!data.id) return { ok: false, error: '缺少任务ID' };

  const oldQuests = doc.quests || [];
  const quests = oldQuests.filter(q => q.id !== data.id);
  if (quests.length === oldQuests.length) return { ok: false, error: '任务不存在' };

  await updateUserDoc(doc._id, { quests });
  return { ok: true };
}

async function completeQuest(openid, data) {
  const doc = await getUserDoc(openid);
  if (!data.id) return { ok: false, error: '缺少任务ID' };

  const target = (doc.quests || []).find(q => q.id === data.id);
  if (!target) return { ok: false, error: '任务不存在' };
  if (target.completed_at) return { ok: false, error: '任务已完成' };

  let earnedXp = 0, earnedWealth = 0, earnedMinutes = 0;

  const quests = (doc.quests || []).map(q => {
    if (q.id !== data.id || q.completed_at) return q;
    earnedXp = q.reward_xp || 0;
    earnedWealth = q.reward_wealth || 0;
    earnedMinutes = q.duration_minutes || 0;
    return { ...q, completed_at: new Date().toISOString(), status: 'done' };
  });

  // 更新 player
  const oldPlayer = doc.player || {};
  const player = applyLevelUp({
    ...oldPlayer,
    level: oldPlayer.level || 1,
    xp: (oldPlayer.xp || 0) + earnedXp,
    wealth: (oldPlayer.wealth || 0) + earnedWealth,
    total_done: (oldPlayer.total_done || 0) + 1,
    total_minutes: (oldPlayer.total_minutes || 0) + earnedMinutes,
  });

  // 更新快捷标签
  const completedQuest = quests.find(q => q.id === data.id);
  let tags = doc.tags || [];
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

  await updateUserDoc(doc._id, { quests, player, tags });
  return { ok: true, earned: { xp: earnedXp, wealth: earnedWealth }, player };
}

async function useTag(openid, data) {
  const doc = await getUserDoc(openid);
  const tag = (doc.tags || []).find(t => t.id === data.tag_id);
  if (!tag) return { ok: false, error: '标签不存在' };

  const { start } = data;
  if (!isValidDateTime(start)) return { ok: false, error: '时间格式不正确' };
  if (!tag.duration_minutes || tag.duration_minutes <= 0 || tag.duration_minutes > MAX_DURATION_MINUTES) {
    return { ok: false, error: '标签时长不正确' };
  }
  const startDate = new Date(start.replace(' ', 'T'));
  const endDate = new Date(startDate.getTime() + tag.duration_minutes * 60000);
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,'0')}-${String(endDate.getDate()).padStart(2,'0')} ${String(endDate.getHours()).padStart(2,'0')}:${String(endDate.getMinutes()).padStart(2,'0')}`;

  const rewards = calcRewards(tag.duration_minutes, tag.task_type);
  const quest = {
    id: uuid(),
    title: tag.title,
    task_type: tag.task_type,
    course_name: tag.course_name || '',
    start,
    end,
    duration_minutes: tag.duration_minutes,
    ...rewards,
    status: 'upcoming',
    completed_at: null,
    calendar_sync_status: 'none',
  };

  const quests = [...(doc.quests || []), quest];
  const tags = (doc.tags || []).map(t => t.id === data.tag_id ? { ...t, uses: (t.uses || 0) + 1 } : t);
  await updateUserDoc(doc._id, { quests, tags });
  return { ok: true, quest };
}

// ── 入口 ──────────────────────────────────────────────
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: '未登录' };

  const { action, data = {} } = event;
  try {
    switch (action) {
      case 'getState':     return getState(OPENID);
      case 'addQuest':     return addQuest(OPENID, data);
      case 'editQuest':    return editQuest(OPENID, data);
      case 'deleteQuest':  return deleteQuest(OPENID, data);
      case 'completeQuest': return completeQuest(OPENID, data);
      case 'useTag':       return useTag(OPENID, data);
      default: return { ok: false, error: `未知操作: ${action}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
