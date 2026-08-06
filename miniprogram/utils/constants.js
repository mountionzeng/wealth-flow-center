const TASK_TYPES = {
  course:    { label: '课程学习', xp_mult: 1.0, wealth_mult: 1.0, color: '#7a5c10', bg: 'rgba(200,170,80,.15)' },
  review:    { label: '复习巩固', xp_mult: 0.9, wealth_mult: 0.9, color: '#2c5878', bg: 'rgba(80,140,190,.14)' },
  skill:     { label: '技能拓展', xp_mult: 1.1, wealth_mult: 1.2, color: '#3a6e48', bg: 'rgba(80,160,100,.13)' },
  practice:  { label: '实践',    xp_mult: 1.05, wealth_mult: 1.1, color: '#804020', bg: 'rgba(180,100,50,.13)' },
  knowledge: { label: '知识库搭建', xp_mult: 1.0, wealth_mult: 1.1, color: '#5a3a70', bg: 'rgba(140,80,180,.13)' },
  homework:  { label: '做作业', xp_mult: 0.95, wealth_mult: 1.0, color: '#4a4a50', bg: 'rgba(120,120,130,.12)' },
};

const TASK_TYPE_LIST = Object.entries(TASK_TYPES).map(([k, v]) => ({ key: k, ...v }));
const TASK_TYPE_LABELS = TASK_TYPE_LIST.map(t => t.label);
const TASK_TYPE_KEYS   = TASK_TYPE_LIST.map(t => t.key);

function getTaskType(key) {
  return TASK_TYPES[key] || TASK_TYPES.course;
}

function calcRewards(durationMinutes, taskType) {
  const tc = TASK_TYPES[taskType] || TASK_TYPES.course;
  const xp = Math.max(20, Math.floor(durationMinutes * 0.8 * tc.xp_mult));
  const wealth = Math.max(2, Math.floor((durationMinutes / 15) * tc.wealth_mult));
  return { xp, wealth };
}

module.exports = { TASK_TYPES, TASK_TYPE_LIST, TASK_TYPE_LABELS, TASK_TYPE_KEYS, getTaskType, calcRewards };
