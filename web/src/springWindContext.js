import { normalizeDailyBalanceState } from './dailyBalance.js';

const WINDOW_DAYS = 30;
const ALLOWED_CATEGORIES = ['body_history', 'learning_history', 'calendar_history'];
const CALENDAR_FIELDS = ['calendar_name', 'title', 'start', 'end', 'duration_minutes'];

const text = (value, limit) => String(value || '').trim().slice(0, limit);
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const datePart = value => {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || '';
};
const shiftDate = (date, days) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const within = (value, start, end) => {
  const date = datePart(value);
  return Boolean(date && date >= start && date <= end);
};
const sum = (rows, accessor) => rows.reduce((total, row) => total + number(accessor(row)), 0);

const suggestionIndex = daily => {
  const index = new Map();
  daily.advice.forEach(advice => advice.suggestions.forEach(suggestion => {
    index.set(String(suggestion.id), {
      ...suggestion,
      advice_date: advice.date,
    });
  }));
  return index;
};

const planIndex = daily => new Map(daily.plans.map(plan => [String(plan.suggestion_id), plan]));

const kindAllowed = (kind, allowed) => kind === 'body'
  ? allowed.has('body_history')
  : allowed.has('learning_history');

const normalizedExecution = (daily, allowed) => {
  const suggestions = suggestionIndex(daily);
  const plans = planIndex(daily);
  return daily.completions.flatMap(completion => {
    const sourceId = String(completion.source_id || '');
    const suggestion = suggestions.get(sourceId);
    const kind = suggestion?.kind === 'body' ? 'body' : 'learning';
    if (!kindAllowed(kind, allowed)) return [];
    const plan = plans.get(sourceId);
    const planned = number(plan?.planned_duration_minutes ?? suggestion?.planned_duration_minutes);
    const actual = number(completion.actual_duration_minutes);
    return [{
      source_id: sourceId,
      kind,
      title: text(suggestion?.title, 120),
      date: datePart(completion.completed_at || completion.actual_end || suggestion?.advice_date),
      planned_minutes: planned,
      actual_minutes: actual,
      variance_minutes: Number.isFinite(Number(completion.variance_minutes))
        ? Number(completion.variance_minutes)
        : actual - planned,
      feeling: text(completion.feeling, 160),
    }];
  });
};

const normalizedCalendar = events => (Array.isArray(events) ? events : []).slice(0, 100).flatMap(raw => {
  if (!raw || typeof raw !== 'object') return [];
  const event = {
    calendar_name: text(raw.calendar_name, 80),
    title: text(raw.title, 160),
    start: text(raw.start, 40),
    end: text(raw.end, 40),
    duration_minutes: Math.max(0, Math.min(1440, Math.round(number(raw.duration_minutes)))),
  };
  return event.calendar_name && event.title && event.start && event.end ? [event] : [];
});

export const buildSpringWindContext = ({
  dailyBalance,
  quests = [],
  calendarEvents = [],
  allowedCategories = [],
  now = new Date(),
} = {}) => {
  const daily = normalizeDailyBalanceState(dailyBalance);
  const allowed = new Set(
    (Array.isArray(allowedCategories) ? allowedCategories : [])
      .map(String)
      .filter(category => ALLOWED_CATEGORIES.includes(category)),
  );
  const end = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.toISOString().slice(0, 10)
    : datePart(now);
  if (!end) throw new Error('上下文日期无效');
  const start = shiftDate(end, -(WINDOW_DAYS - 1));
  const context = {
    version: 'spring-wind-context-1.0.0',
    window: { start, end, days: WINDOW_DAYS },
  };

  if (allowed.has('body_history')) {
    const recentCheckIns = daily.check_ins
      .filter(row => within(row.date, start, end))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-30)
      .map(row => ({
        date: datePart(row.date),
        sleep: number(row.sleep),
        energy: number(row.energy),
        mood: number(row.mood),
        discomfort: text(row.discomfort, 80),
        note: text(row.note, 240),
      }));
    context.body = { recent_check_ins: recentCheckIns };
  }

  if (allowed.has('learning_history')) {
    const completed = (Array.isArray(quests) ? quests : [])
      .filter(row => row?.status === 'done' && within(row.completed_at || row.actual_end, start, end))
      .sort((a, b) => String(a.completed_at || a.actual_end).localeCompare(String(b.completed_at || b.actual_end)))
      .slice(-40)
      .map(row => ({
        id: text(row.id, 80),
        title: text(row.title, 160),
        completed_at: text(row.completed_at || row.actual_end, 40),
        planned_minutes: number(row.planned_duration_minutes ?? row.duration_minutes),
        actual_minutes: number(row.actual_duration_minutes ?? row.duration_minutes),
        variance_minutes: number(row.variance_minutes),
        feeling: text(row.feeling, 160),
      }));
    context.learning = { recent_completed_tasks: completed };
  }

  const allExecution = normalizedExecution(daily, allowed);
  if (allowed.has('body_history') || allowed.has('learning_history')) {
    context.execution = {
      recent: allExecution.filter(row => within(row.date, start, end)).slice(-60),
    };
  }

  if (allowed.has('calendar_history')) {
    const events = normalizedCalendar(calendarEvents).filter(event => within(event.start, start, end));
    context.calendar = {
      events,
      fields: CALENDAR_FIELDS,
    };
  }

  const completedQuests = allowed.has('learning_history')
    ? (Array.isArray(quests) ? quests : []).filter(row => row?.status === 'done')
    : [];
  const historySummary = {};
  if (allowed.has('body_history')) historySummary.check_in_count = daily.check_ins.length;
  if (allowed.has('body_history') || allowed.has('learning_history')) {
    historySummary.completion_count = allExecution.length;
    historySummary.planned_minutes = sum(allExecution, row => row.planned_minutes);
    historySummary.actual_minutes = sum(allExecution, row => row.actual_minutes);
    historySummary.variance_minutes = sum(allExecution, row => row.variance_minutes);
  }
  if (allowed.has('learning_history')) {
    historySummary.completed_quest_count = completedQuests.length;
    historySummary.completed_quest_actual_minutes = sum(
      completedQuests,
      row => row.actual_duration_minutes ?? row.duration_minutes,
    );
  }
  context.history_summary = historySummary;

  const included = ALLOWED_CATEGORIES.filter(category => allowed.has(category));
  context.manifest = {
    included,
    omitted: ALLOWED_CATEGORIES.filter(category => !allowed.has(category)),
    coverage: { start, end },
    samples: {
      recent_check_ins: context.body?.recent_check_ins.length || 0,
      recent_completions: context.execution?.recent.length || 0,
      recent_learning_tasks: context.learning?.recent_completed_tasks.length || 0,
      calendar_events: context.calendar?.events.length || 0,
      all_check_ins: allowed.has('body_history') ? daily.check_ins.length : 0,
      all_completions: allExecution.length,
      all_completed_quests: completedQuests.length,
    },
  };
  return context;
};

