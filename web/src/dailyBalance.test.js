import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createDailyBalanceState,
  normalizeDailyBalanceState,
  saveCheckIn,
  storeAdvice,
  confirmSuggestion,
  consentMatches,
  recordCompletion,
  updateProjection,
  preparePortableDailyBalance,
} from './dailyBalance.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

test('schema v2 defaults are complete', () => {
  assert.deepEqual(createDailyBalanceState(), {
    check_ins: [], advice: [], plans: [], completions: [], projections: [], spring_wind: null,
    consent: { purposes: { daily_advice: null, spring_wind_text: null, environment: null, image_recognition: null, knowledge_refine: null } },
    calendar_preferences: { selected_calendars: [] },
  });
});

test('planned and actual time remain separate and completion is idempotent', () => {
  let state = createDailyBalanceState();
  state = storeAdvice(state, { date: '2026-08-05', suggestions: [{ id: 'study-1', kind: 'learning', title: '读书', planned_start: '2026-08-05 09:00', planned_duration_minutes: 40 }] });
  state = confirmSuggestion(state, 'study-1');
  state = recordCompletion(state, { id: 'completion-1', source_id: 'study-1', actual_duration_minutes: 25, feeling: '专注', completed_at: '2026-08-05 09:30' });
  state = recordCompletion(state, { id: 'completion-2', source_id: 'study-1', actual_duration_minutes: 35, feeling: 'duplicate', completed_at: '2026-08-05 10:00' });

  assert.equal(state.plans[0].planned_duration_minutes, 40);
  assert.equal(state.plans[0].status, 'completed');
  assert.equal(state.completions.length, 1);
  assert.equal(state.completions[0].actual_duration_minutes, 25);
  assert.equal(state.completions[0].variance_minutes, -15);
  assert.equal(state.completions[0].reward_basis, 'actual');
});

test('partial completion closes the source and keeps a negative variance', () => {
  let state = createDailyBalanceState();
  state = storeAdvice(state, { date: '2026-08-05', suggestions: [{ id: 'body-1', kind: 'body', title: '步行', planned_start: '2026-08-05 12:00', planned_duration_minutes: 30 }] });
  state = confirmSuggestion(state, 'body-1');
  state = recordCompletion(state, { source_id: 'body-1', actual_duration_minutes: 10, completed_at: '2026-08-05 12:15' });
  assert.equal(state.plans[0].status, 'completed');
  assert.equal(state.completions[0].variance_minutes, -20);
  assert.equal(state.plans[0].remaining_duration_minutes, undefined);
});

test('same-day regeneration replaces drafts, preserves confirmed plans, and creates new ids', () => {
  let state = createDailyBalanceState();
  state = storeAdvice(state, { date: '2026-08-05', suggestions: [
    { id: 'old-body', kind: 'body', title: '旧身体', planned_start: '2026-08-05 08:00', planned_duration_minutes: 10 },
    { id: 'old-study', kind: 'learning', title: '旧学习', planned_start: '2026-08-05 09:00', planned_duration_minutes: 20 },
  ] });
  state = confirmSuggestion(state, 'old-study');
  state = storeAdvice(state, { date: '2026-08-05', suggestions: [
    { id: 'old-body', kind: 'body', title: '新身体', planned_start: '2026-08-05 10:00', planned_duration_minutes: 15 },
    { id: 'old-study', kind: 'learning', title: '新学习', planned_start: '2026-08-05 11:00', planned_duration_minutes: 25 },
  ] });

  assert.equal(state.plans.length, 1);
  assert.equal(state.plans[0].suggestion_id, 'old-study');
  const latest = state.advice.at(-1).suggestions;
  assert.equal(latest.some(row => row.id === 'old-body' || row.id === 'old-study'), false);
  assert.equal(new Set(latest.map(row => row.id)).size, 2);
});

test('projection responses are attempt-guarded and success is terminal', () => {
  let state = createDailyBalanceState();
  state = updateProjection(state, 'entity-1', { operation_id: 'op-1', attempt_id: 'attempt-old', state: 'pending' });
  state = updateProjection(state, 'entity-1', { operation_id: 'op-1', attempt_id: 'attempt-new', state: 'pending' });
  state = updateProjection(state, 'entity-1', { operation_id: 'op-1', attempt_id: 'attempt-new', state: 'succeeded', event_id: 'evt-1' });
  state = updateProjection(state, 'entity-1', { operation_id: 'op-1', attempt_id: 'attempt-old', state: 'failed' });
  state = updateProjection(state, 'entity-1', { operation_id: 'op-1', attempt_id: 'attempt-new', state: 'failed' });
  assert.equal(state.projections[0].state, 'succeeded');
  assert.equal(state.projections[0].event_id, 'evt-1');
});

test('normalization rejects duplicate ids and dangling references', () => {
  assert.throws(() => normalizeDailyBalanceState({ advice: [
    { id: 'same', date: '2026-08-05', suggestions: [] },
    { id: 'same', date: '2026-08-06', suggestions: [] },
  ] }), /重复/);
  assert.throws(() => normalizeDailyBalanceState({ completions: [
    { id: 'c1', source_id: 'missing', actual_duration_minutes: 10 },
  ] }), /引用/);
});

test('portable clone keeps raw personal truth and clears provider grants and normalized places', () => {
  const state = normalizeDailyBalanceState({
    check_ins: [{ id: 'ci', date: '2026-08-05', sleep: 2, energy: 3, mood: 4, discomfort: '' }],
    advice: [{ id: 'a', date: '2026-08-05', suggestions: [{ id: 's', kind: 'body', title: '休息', planned_duration_minutes: 20 }] }],
    plans: [{ id: 'p', suggestion_id: 's', planned_duration_minutes: 20, status: 'confirmed' }],
    completions: [{ id: 'c', source_id: 's', actual_duration_minutes: 10, variance_minutes: -10 }],
    projections: [{ entity_id: 's', operation_id: 'op', attempt_id: 'try', state: 'succeeded', event_id: 'evt' }],
    spring_wind: {
      profile: { bazi: '甲子 丙寅 壬午 辛亥', birth_city: '成都', current_city: '北京' },
      locations: { birth: { id: 'birth-place' }, current: { id: 'current-place' } },
      report: 'report',
    },
    consent: {
      text: { granted: true, operation: 'text', provider_name: '旧服务', fields_version: 'v1', terms_version: 'v1' },
      image: { granted: true, operation: 'image', provider_name: '旧服务', fields_version: 'v1', terms_version: 'v1' },
    },
    calendar_preferences: { selected_calendars: ['cal'] },
  });
  const portable = preparePortableDailyBalance(state);
  assert.equal(portable.spring_wind.report, 'report');
  assert.equal(portable.spring_wind.profile.birth_city, '成都');
  assert.equal(portable.spring_wind.profile.current_city, '北京');
  assert.deepEqual(portable.spring_wind.locations, { birth: null, current: null });
  assert.deepEqual(portable.calendar_preferences.selected_calendars, []);
  assert.deepEqual(portable.consent, {
    purposes: { daily_advice: null, spring_wind_text: null, environment: null, image_recognition: null, knowledge_refine: null },
  });
  assert.deepEqual(portable.projections[0], { entity_id: 's', operation_id: 'op', attempt_id: null, state: 'not_synced', event_id: null });
});

test('check-in is unique per date', () => {
  let state = createDailyBalanceState();
  state = saveCheckIn(state, { date: '2026-08-05', sleep: 2, energy: 3, mood: 4, discomfort: '腰' });
  state = saveCheckIn(state, { date: '2026-08-05', sleep: 4, energy: 5, mood: 5, discomfort: '' });
  assert.equal(state.check_ins.length, 1);
  assert.equal(state.check_ins[0].sleep, 4);
});

test('consent is bound to purpose, receiver, categories and disclosure versions', () => {
  const consent = {
    granted: true, purpose: 'daily_advice', operation: 'text', provider_name: '302.ai',
    categories: ['body_check_in', 'calendar_summary'], fields_version: 'daily-v1', terms_version: '2026-08',
  };
  const matching = {
    purpose: 'daily_advice', operation: 'text', provider_name: '302.ai',
    categories: ['calendar_summary', 'body_check_in'], fields_version: 'daily-v1', terms_version: '2026-08',
  };
  assert.equal(consentMatches(consent, matching), true);
  assert.equal(consentMatches(consent, { ...matching, purpose: 'spring_wind_text' }), false);
  assert.equal(consentMatches(consent, { ...matching, provider_name: '另一个服务' }), false);
  assert.equal(consentMatches(consent, { ...matching, fields_version: 'daily-v2' }), false);
  assert.equal(consentMatches(consent, { ...matching, categories: [...matching.categories, 'learning_history'] }), false);
  assert.equal(consentMatches({ ...consent, revoked_at: '2026-08-06T00:00:00Z' }, matching), false);
});

test('legacy city and shared consents migrate without guessing birth city or losing old report', () => {
  const state = normalizeDailyBalanceState({
    spring_wind: { profile: { bazi: '甲子', city: '北京 通州', question: '今日如何' }, report: '# 旧报告' },
    consent: {
      text: { granted: true, operation: 'text', provider_name: '302.ai', fields_version: 'daily-v1', terms_version: 'v1' },
      image: { granted: true, operation: 'image', provider_name: '302.ai', fields_version: 'image-v1', terms_version: 'v1' },
    },
  });

  assert.equal(state.spring_wind.profile.birth_city, '');
  assert.equal(state.spring_wind.profile.current_city, '北京 通州');
  assert.equal(state.spring_wind.profile.city, undefined);
  assert.equal(state.spring_wind.report, '# 旧报告');
  assert.equal(state.consent.purposes.daily_advice.purpose, 'daily_advice');
  assert.equal(state.consent.purposes.spring_wind_text, null);
  assert.equal(state.consent.purposes.image_recognition.purpose, 'image_recognition');
});
