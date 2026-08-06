import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(repoRoot, 'study_state.json');
const outputPath = path.join(
  repoRoot,
  'miniprogram',
  'cloudfunctions',
  'importLegacyStudyData',
  'legacy-study-state.json',
);

function xpToNextLevel(level) {
  return 100 + (level - 1) * 40;
}

function normalizeTaskType(taskType) {
  const allowed = new Set(['course', 'review', 'skill', 'practice', 'knowledge', 'homework']);
  return allowed.has(taskType) ? taskType : 'course';
}

function normalizeQuest(quest) {
  return {
    id: quest.id,
    title: String(quest.title || ''),
    task_type: normalizeTaskType(quest.task_type),
    course_name: String(quest.course_name || ''),
    start: String(quest.start || ''),
    end: String(quest.end || ''),
    duration_minutes: Number(quest.duration_minutes || 0),
    reward_xp: Number(quest.reward_xp || 0),
    reward_wealth: Number(quest.reward_wealth || 0),
    status: quest.completed_at || quest.status === 'done' ? 'done' : 'upcoming',
    created_at: quest.created_at || null,
    completed_at: quest.completed_at || null,
    calendar_sync_status: quest.calendar_sync_status || 'none',
    calendar_sync_message: quest.calendar_sync_message || '',
  };
}

function normalizeTag(tag) {
  return {
    id: tag.id,
    title: String(tag.title || ''),
    task_type: normalizeTaskType(tag.task_type),
    course_name: String(tag.course_name || ''),
    duration_minutes: Number(tag.duration_minutes || 0),
    uses: Number(tag.uses || 0),
    last_used_at: tag.last_used_at || null,
  };
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const player = {
  level: Number(source.player?.level || 1),
  xp: Number(source.player?.xp || 0),
  xp_target: xpToNextLevel(Number(source.player?.level || 1)),
  wealth: Number(source.player?.wealth || 0),
  streak: Number(source.player?.streak || 0),
  last_completed_date: source.player?.last_completed_date || null,
  total_done: Number(source.player?.total_done || 0),
  total_minutes: Number(source.player?.total_minutes || 0),
};

const payload = {
  source: 'study_state.json',
  generated_at: new Date().toISOString(),
  player,
  quests: (source.quests || []).map(normalizeQuest),
  tags: (source.quick_tags || source.tags || []).map(normalizeTag),
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n');

console.log(`Wrote ${payload.quests.length} quests and ${payload.tags.length} tags to ${outputPath}`);
