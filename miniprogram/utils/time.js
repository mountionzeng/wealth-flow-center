// 格式化为 "MM-DD HH:mm"
function fmtTime(dtStr) {
  if (!dtStr) return '';
  const d = new Date(dtStr.replace(' ', 'T'));
  if (isNaN(d)) return dtStr;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

// 格式化 "YYYY-MM-DD"
function fmtDate(dtStr) {
  if (!dtStr) return '';
  const d = new Date(dtStr.replace(' ', 'T'));
  if (isNaN(d)) return dtStr;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 格式化毫秒剩余时间
function fmtMs(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// 今天的日期字符串
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 把 "YYYY-MM-DD" + "HH:mm" 合并为 "YYYY-MM-DD HH:mm"
function combineDateTime(date, time) {
  return `${date} ${time}`;
}

// 计算时长（分钟）
function diffMinutes(startStr, endStr) {
  const s = new Date(startStr.replace(' ', 'T'));
  const e = new Date(endStr.replace(' ', 'T'));
  return Math.max(0, Math.round((e - s) / 60000));
}

// 判断任务状态
function questStatus(q) {
  if (q.completed_at) return 'done';
  const now = Date.now();
  const st = new Date(q.start.replace(' ', 'T')).getTime();
  const en = new Date(q.end.replace(' ', 'T')).getTime();
  if (now < st) return 'upcoming';
  if (now <= en) return 'active';
  return 'overdue';
}

// 生成 UUID
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = { fmtTime, fmtDate, fmtMs, todayStr, combineDateTime, diffMinutes, questStatus, uuid };
