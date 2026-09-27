const pad = value => String(value).padStart(2, '0');

const localDate = value => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;

const datePart = value => {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || '';
};

const timePart = value => {
  const text = String(value || '').trim();
  const match = text.match(/[ T](\d{2}:\d{2})/);
  return match?.[1] || '';
};

const duration = value => {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null;
};

const weekday = value => `周${'日一二三四五六'[value.getDay()]}`;

const sevenDays = now => {
  const end = new Date(now);
  end.setHours(12, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - (6 - index));
    const key = localDate(date);
    return {
      key,
      label: index === 6 ? '今天' : weekday(date),
      dateLabel: `${pad(date.getMonth() + 1)}.${pad(date.getDate())}`,
      isToday: index === 6,
      entries: [],
    };
  });
};

export const buildWeeklyTimeline = ({ quests = [], daily = {}, now = new Date() } = {}) => {
  const days = sevenDays(now);
  const byDate = new Map(days.map(day => [day.key, day]));
  const suggestions = new Map(
    (daily.advice || []).flatMap(row => row?.suggestions || []).map(item => [String(item.id), item]),
  );

  (daily.check_ins || []).forEach(checkIn => {
    const day = byDate.get(datePart(checkIn?.date));
    if (!day) return;
    day.entries.push({
      id: `checkin-${checkIn.id || checkIn.date}`,
      kind: 'body',
      title: '身体签到',
      detail: checkIn.discomfort && checkIn.discomfort !== '无明显不适' ? checkIn.discomfort : '',
      time: '',
      minutes: null,
    });
  });

  (daily.completions || []).forEach(completion => {
    const completedAt = completion?.actual_end || completion?.completed_at;
    const day = byDate.get(datePart(completedAt));
    if (!day) return;
    const suggestion = suggestions.get(String(completion.source_id));
    day.entries.push({
      id: `completion-${completion.id || completion.source_id}`,
      kind: suggestion?.kind === 'body' ? 'body' : 'learning',
      title: suggestion?.title || (suggestion?.kind === 'body' ? '养身记录' : '学习记录'),
      detail: String(completion.feeling || '').trim(),
      time: timePart(completedAt),
      minutes: duration(completion.actual_duration_minutes),
    });
  });

  quests.forEach(quest => {
    if (quest?.status !== 'done' && !quest?.completed_at) return;
    const completedAt = quest.actual_end || quest.completed_at || quest.end;
    const day = byDate.get(datePart(completedAt));
    if (!day) return;
    day.entries.push({
      id: `quest-${quest.id}`,
      kind: 'learning',
      title: String(quest.title || '学习任务'),
      detail: String(quest.course_name || quest.feeling || '').trim(),
      time: timePart(completedAt),
      minutes: duration(quest.actual_duration_minutes ?? quest.duration_minutes),
    });
  });

  days.forEach(day => day.entries.sort((a, b) => `${a.time || '99:99'}-${a.id}`.localeCompare(`${b.time || '99:99'}-${b.id}`)));
  return days;
};

export const buildWorkTimeline = ({ work = {}, now = new Date() } = {}) => {
  const days = sevenDays(now);
  const byDate = new Map(days.map(day => [day.key, day]));

  (work.projects || []).forEach(project => {
    (project.tasks || []).forEach(task => {
      if (task?.status !== 'done' || !task.completed_at) return;
      const day = byDate.get(datePart(task.completed_at));
      if (!day) return;
      day.entries.push({
        id: `work-${project.id}-${task.id}`,
        kind: 'work',
        title: String(task.title || '工作任务'),
        detail: String(project.title || '').trim(),
        time: timePart(task.completed_at),
        minutes: null,
      });
    });
  });

  days.forEach(day => day.entries.sort((a, b) => `${a.time || '99:99'}-${a.id}`.localeCompare(`${b.time || '99:99'}-${b.id}`)));
  return days;
};
