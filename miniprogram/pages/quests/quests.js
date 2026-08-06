const { TASK_TYPE_LABELS, TASK_TYPE_KEYS, getTaskType } = require('../../utils/constants');
const { fmtTime, todayStr, combineDateTime, diffMinutes, questStatus } = require('../../utils/time');
const { callStudyApi } = require('../../utils/cloud');

const DEFAULT_FORM = {
  title: '',
  task_type_idx: 0,
  course_name: '',
  start_date: '',
  start_time: '09:00',
  end_date: '',
  end_time: '10:00',
};

Page({
  data: {
    player: {},
    playerStats: { streak: 0, total_minutes: 0, level: 1 },
    quests: [],
    activeQuests: [],
    completedQuests: [],
    formTags: [],
    loading: true,
    showForm: false,
    editId: null,
    form: { ...DEFAULT_FORM },
    taskTypeLabels: TASK_TYPE_LABELS,
    busy: false,
    toast: null,
    confirmId: null,
    serverTime: '',
    // 倒计时 tick
    _timer: null,
    now: Date.now(),
  },

  onLoad() {
    const today = todayStr();
    this.setData({ 'form.start_date': today, 'form.end_date': today });
    this.loadState();
    this._startTimer();
  },

  onShow() {
    this.loadState();
  },

  onUnload() {
    this._stopTimer();
  },

  _startTimer() {
    this._timer = setInterval(() => {
      const now = Date.now();
      const quests = (this.data.quests || []).map(q => this._enrichQuest(q, now));
      this.setData({ now, quests, ...this._splitQuests(quests) });
    }, 1000);
  },

  _stopTimer() {
    if (this._timer) clearInterval(this._timer);
  },

  async loadState() {
    try {
      const result = await callStudyApi('getState');
      const { player, quests, tags } = result;
      const enriched = (quests || []).map(q => this._enrichQuest(q));
      this.setData({
        player: player || {},
        playerStats: this._playerStats(player || {}),
        quests: enriched,
        ...this._splitQuests(enriched),
        formTags: this._formTags(tags || []),
        loading: false,
        serverTime: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      });
      // 缓存到全局
      getApp().globalData.state = result;
    } catch (e) {
      this.showToast(e.message || '加载失败', 'e');
      this.setData({ loading: false });
    }
  },

  // ── 数据增强（给 WXML 用的颜色、label、格式化时间）────────
  _enrichQuest(q, now = this.data.now) {
    const tc = getTaskType(q.task_type);
    const status = questStatus(q);
    const cd = this.getCountdown(q, now);
    const startFmt = fmtTime(q.start);
    const endFmt = fmtTime(q.end);
    const durationText = q.duration_minutes ? ` · ${q.duration_minutes}m` : '';
    const statusLabel = q.completed_at ? '已完成' : status === 'overdue' ? '已逾期' : status === 'active' ? '进行中' : '待开始';
    return {
      ...q,
      status,
      tc_color: tc.color,
      tc_bg: tc.bg,
      tc_label: tc.label,
      start_fmt: startFmt,
      end_fmt: endFmt,
      time_desc: `${startFmt} - ${endFmt}${durationText}`,
      status_label: statusLabel,
      card_class: status === 'overdue' ? 'qc-over' : '',
      cd_text: cd.text,
      cd_cls: cd.cls,
    };
  },

  _splitQuests(quests) {
    return {
      activeQuests: quests.filter(q => !q.completed_at),
      completedQuests: quests.filter(q => q.completed_at),
    };
  },

  _playerStats(player) {
    return {
      streak: player.streak || 0,
      total_minutes: player.total_minutes || 0,
      level: player.level || 1,
    };
  },

  _formTags(tags) {
    return tags
      .slice()
      .sort((a, b) => (b.uses || 0) - (a.uses || 0))
      .slice(0, 12)
      .map(tag => {
        const tc = getTaskType(tag.task_type);
        return {
          ...tag,
          tc_color: tc.color,
          tc_bg: tc.bg,
          tc_label: tc.label,
          meta: `${tag.course_name || '未分课程'} · ${tag.duration_minutes || 60} 分钟`,
        };
      });
  },

  // ── 表单 ─────────────────────────────────────────────
  openCreate() {
    const today = todayStr();
    this.setData({
      showForm: true,
      editId: null,
      form: { ...DEFAULT_FORM, start_date: today, end_date: today },
    });
  },

  openEdit(e) {
    const q = e.currentTarget.dataset.quest;
    const [sd, st] = (q.start || ' ').split(' ');
    const [ed, et] = (q.end || ' ').split(' ');
    this.setData({
      showForm: true,
      editId: q.id,
      form: {
        title: q.title || '',
        task_type_idx: TASK_TYPE_KEYS.indexOf(q.task_type) >= 0 ? TASK_TYPE_KEYS.indexOf(q.task_type) : 0,
        course_name: q.course_name || '',
        start_date: sd || todayStr(),
        start_time: (st || '09:00').slice(0, 5),
        end_date: ed || todayStr(),
        end_time: (et || '10:00').slice(0, 5),
      },
    });
  },

  closeForm() { this.setData({ showForm: false }); },

  onInputTitle(e) { this.setData({ 'form.title': e.detail.value }); },
  onInputCourse(e) { this.setData({ 'form.course_name': e.detail.value }); },
  onPickType(e)    { this.setData({ 'form.task_type_idx': e.detail.value }); },
  onPickStartDate(e) { this.setData({ 'form.start_date': e.detail.value }); },
  onPickStartTime(e) { this.setData({ 'form.start_time': e.detail.value }); },
  onPickEndDate(e)   { this.setData({ 'form.end_date': e.detail.value }); },
  onPickEndTime(e)   { this.setData({ 'form.end_time': e.detail.value }); },

  stopPropagation(e) { /* block sheet close */ },

  applyFormTag(e) {
    const tag = e.currentTarget.dataset.tag;
    if (!tag) return;

    const duration = Number(tag.duration_minutes || 60);
    const start = combineDateTime(this.data.form.start_date || todayStr(), this.data.form.start_time || '09:00');
    const endParts = this._addMinutes(start, duration);
    const typeIdx = TASK_TYPE_KEYS.indexOf(tag.task_type);

    this.setData({
      'form.title': tag.title || '',
      'form.task_type_idx': typeIdx >= 0 ? typeIdx : 0,
      'form.course_name': tag.course_name || '',
      'form.end_date': endParts.date,
      'form.end_time': endParts.time,
    });
  },

  _addMinutes(start, minutes) {
    const base = new Date(start.replace(' ', 'T'));
    const d = Number.isNaN(base.getTime()) ? new Date() : base;
    d.setMinutes(d.getMinutes() + minutes);
    return {
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    };
  },

  async submitForm() {
    const { form, editId } = this.data;
    if (!form.title.trim()) { this.showToast('请填写任务名称', 'e'); return; }

    const start = combineDateTime(form.start_date, form.start_time);
    const end   = combineDateTime(form.end_date,   form.end_time);
    if (diffMinutes(start, end) <= 0) { this.showToast('结束时间必须晚于开始时间', 'e'); return; }

    const payload = {
      title: form.title.trim(),
      task_type: TASK_TYPE_KEYS[form.task_type_idx] || 'course',
      course_name: form.course_name.trim(),
      start,
      end,
    };

    this.setData({ busy: true });
    try {
      if (editId) {
        await callStudyApi('editQuest', { ...payload, id: editId });
        this.showToast('已更新', 's');
      } else {
        await callStudyApi('addQuest', payload);
        this.showToast('任务已创建', 's');
      }
      this.setData({ showForm: false });
      await this.loadState();
    } catch (e) {
      this.showToast(e.message || '操作失败', 'e');
    } finally {
      this.setData({ busy: false });
    }
  },

  // ── 完成任务 ──────────────────────────────────────────
  async completeQuest(e) {
    const id = e.currentTarget.dataset.id;
    try {
      const result = await callStudyApi('completeQuest', { id });
      const { xp, wealth } = result.earned || {};
      this.showToast(`完成！+${xp} XP  +${wealth} ◈`, 's');
      await this.loadState();
    } catch (e) {
      this.showToast(e.message || '操作失败', 'e');
    }
  },

  // ── 删除任务 ──────────────────────────────────────────
  askDelete(e) { this.setData({ confirmId: e.currentTarget.dataset.id }); },
  cancelDelete() { this.setData({ confirmId: null }); },
  async confirmDelete() {
    const id = this.data.confirmId;
    this.setData({ confirmId: null });
    try {
      await callStudyApi('deleteQuest', { id });
      this.showToast('已删除', 's');
      await this.loadState();
    } catch (e) {
      this.showToast(e.message || '删除失败', 'e');
    }
  },

  // ── Toast ─────────────────────────────────────────────
  showToast(msg, type) {
    this.setData({ toast: { msg, type } });
    setTimeout(() => this.setData({ toast: null }), 2200);
  },

  // ── 倒计时显示 ─────────────────────────────────────────
  getCountdown(q, now = this.data.now) {
    if (q.completed_at) return { text: '已完成', cls: 'cd-done' };
    const st = new Date(q.start.replace(' ', 'T')).getTime();
    const en = new Date(q.end.replace(' ', 'T')).getTime();
    const fmtMs = ms => {
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
      return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
    if (now < st) return { text: `还有 ${fmtMs(st - now)}`, cls: 'cd-soon' };
    if (now <= en) return { text: `剩余 ${fmtMs(en - now)}`, cls: 'cd-live' };
    return { text: '已结束', cls: 'cd-over' };
  },
});
