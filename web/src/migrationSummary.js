import { cloudContentHash, splitAccountState } from './cloudData.js';

const latest = values => values
  .map(value => String(value || ''))
  .filter(Boolean)
  .sort()
  .at(-1) || '';

const category = (count, latestAt = '') => ({ count, ...(latestAt ? { latest_at: latestAt } : {}) });

export const buildMigrationSummary = async rawState => {
  const { snapshot } = splitAccountState(rawState);
  const quests = snapshot.quests;
  const daily = snapshot.daily_balance;
  const knowledge = snapshot.knowledge_base;
  const completed = quests.filter(quest => quest.status === 'done');
  const totalMinutes = completed.reduce((total, quest) => total + Math.max(0, Number(quest.actual_duration_minutes ?? quest.duration_minutes) || 0), 0);
  const cards = knowledge.notes.reduce((total, note) => total + note.review_cards.length, 0);

  return {
    schema_version: 1,
    total_minutes: totalMinutes,
    categories: {
      learning_records: category(quests.length, latest(quests.map(quest => quest.completed_at || quest.end || quest.start))),
      body_check_ins: category(daily.check_ins.length, latest(daily.check_ins.map(item => item.date))),
      spring_wind_reports: category(daily.spring_wind?.report ? 1 : 0, latest([daily.spring_wind?.report?.created_at, daily.spring_wind?.report?.generated_at])),
      knowledge_notes: category(knowledge.notes.length, latest(knowledge.notes.map(note => note.updated_at))),
      review_cards: category(cards, latest(knowledge.notes.map(note => note.updated_at))),
    },
    content_hash: await cloudContentHash(snapshot),
  };
};

export const summariesMatch = (left, right) => Boolean(left && right)
  && left.content_hash === right.content_hash
  && left.total_minutes === right.total_minutes
  && JSON.stringify(left.categories) === JSON.stringify(right.categories);
