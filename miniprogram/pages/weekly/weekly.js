const { callStudyApi } = require('../../utils/cloud');

Page({
  data: {
    weekly: null,
    weeklyArr: [],
    loading: true,
  },

  onShow() {
    this.loadWeekly();
  },

  async loadWeekly() {
    try {
      const state = getApp().globalData.state;
      if (state?.weekly) this.processWeekly(state.weekly);

      const result = await callStudyApi('getState');
      getApp().globalData.state = result;
      this.processWeekly(result.weekly || {});
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  processWeekly(weekly) {
    const weeklyArr = Object.entries(weekly).map(([day, info]) => ({
      day,
      date: info.date || '',
      tasks: (info.tasks || []).map(t => ({
        ...t,
        time_range: t.start && t.end
          ? `${(t.start || '').slice(11, 16)} – ${(t.end || '').slice(11, 16)}`
          : '',
        status_cls: t.completed_at ? 'done' : t.status === 'active' ? 'active' : 'upcoming',
        status_lbl: t.completed_at ? '已完成' : t.status === 'active' ? '进行中' : '待开始',
      })),
    }));
    this.setData({ weeklyArr, loading: false });
  },
});
