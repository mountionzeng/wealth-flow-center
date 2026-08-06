const cloud = require('wx-server-sdk');
const legacyState = require('./legacy-study-state.json');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const IMPORT_TOKEN = 'study-import-2026-05-10';
const CONFIRM_TEXT = 'IMPORT_LOCAL_STUDY_STATE';

function summarize(state) {
  return {
    quests: state.quests.length,
    completed_quests: state.quests.filter(q => q.completed_at).length,
    tags: state.tags.length,
    level: state.player.level,
    xp: state.player.xp,
    wealth: state.player.wealth,
    total_done: state.player.total_done,
    total_minutes: state.player.total_minutes,
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: '未登录：请从小程序端调用该云函数' };
  if (event.token !== IMPORT_TOKEN) return { ok: false, error: '导入口令不正确' };

  const summary = summarize(legacyState);
  if (event.confirm !== CONFIRM_TEXT) {
    return {
      ok: true,
      dry_run: true,
      message: '这是预检查，尚未写入数据库。传入 confirm 后才会导入。',
      confirm_text: CONFIRM_TEXT,
      summary,
    };
  }

  const collection = db.collection('study_data');
  const existing = await collection.where({ _openid: OPENID }).limit(1).get();
  const imported_at = new Date().toISOString();
  const data = {
    _openid: OPENID,
    player: legacyState.player,
    quests: legacyState.quests,
    tags: legacyState.tags,
    import_meta: {
      source: legacyState.source,
      generated_at: legacyState.generated_at,
      imported_at,
      summary,
    },
  };

  if (existing.data.length > 0) {
    const current = existing.data[0];
    await collection.doc(current._id).update({
      data: {
        ...data,
        last_import_backup: {
          backed_up_at: imported_at,
          player: current.player || {},
          quests: current.quests || [],
          tags: current.tags || [],
        },
      },
    });
    return { ok: true, action: 'updated_existing_doc', doc_id: current._id, summary };
  }

  const addRes = await collection.add({ data });
  return { ok: true, action: 'created_new_doc', doc_id: addRes._id, summary };
};
