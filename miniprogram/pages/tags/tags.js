const { getTaskType, TASK_TYPES } = require('../../utils/constants');
const { todayStr, combineDateTime } = require('../../utils/time');
const { callStudyApi } = require('../../utils/cloud');

Page({
  data: {
    tags: [],
    loading: true,
    showSheet: false,
    selectedTag: null,
    start_date: '',
    start_time: '09:00',
    busy: false,
    toast: null,
  },

  onLoad() {
    this.setData({ start_date: todayStr() });
  },

  onShow() {
    this.loadTags();
  },

  async loadTags() {
    try {
      const state = getApp().globalData.state;
      if (state) {
        const tags = (state.tags || []).map(t => {
          const tc = getTaskType(t.task_type);
          return { ...t, tc_color: tc.color, tc_bg: tc.bg, tc_label: tc.label };
        });
        this.setData({ tags, loading: false });
      }
      const result = await callStudyApi('getState');
      getApp().globalData.state = result;
      const tags = (result.tags || []).map(t => {
        const tc = getTaskType(t.task_type);
        return { ...t, tc_color: tc.color, tc_bg: tc.bg, tc_label: tc.label };
      });
      this.setData({ tags, loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  openTag(e) {
    const tag = e.currentTarget.dataset.tag;
    this.setData({
      showSheet: true,
      selectedTag: tag,
      start_date: todayStr(),
      start_time: '09:00',
    });
  },

  closeSheet() { this.setData({ showSheet: false, selectedTag: null }); },
  stopPropagation() {},

  onPickDate(e) { this.setData({ start_date: e.detail.value }); },
  onPickTime(e) { this.setData({ start_time: e.detail.value }); },

  async useTag() {
    const { selectedTag, start_date, start_time } = this.data;
    if (!selectedTag) return;
    const start = combineDateTime(start_date, start_time);
    this.setData({ busy: true });
    try {
      await callStudyApi('useTag', { tag_id: selectedTag.id, start });
      this.showToast('任务已创建', 's');
      this.setData({ showSheet: false, selectedTag: null });
      await this.loadTags();
    } catch (e) {
      this.showToast(e.message || '创建失败', 'e');
    } finally {
      this.setData({ busy: false });
    }
  },

  showToast(msg, type) {
    this.setData({ toast: { msg, type } });
    setTimeout(() => this.setData({ toast: null }), 2200);
  },
});
