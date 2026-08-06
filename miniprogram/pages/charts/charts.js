const { getTaskType } = require('../../utils/constants');
const { callStudyApi } = require('../../utils/cloud');

const BAR_COLORS = ['#c4960e', '#3a6e48', '#2c5878', '#a07848', '#804020', '#8060a0'];

Page({
  data: {
    charts: null,
    loading: true,
    typeEntries: [],
    courseEntries: [],
    dayEntries: [],
  },

  onShow() {
    this.loadCharts();
  },

  async loadCharts() {
    try {
      const state = getApp().globalData.state;
      if (state?.charts) this.processCharts(state.charts);

      const result = await callStudyApi('getState');
      getApp().globalData.state = result;
      this.processCharts(result.charts || {});
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  processCharts(charts) {
    const { days = [], day_minutes = [], type_minutes = {}, course_minutes = {} } = charts;

    const maxD = Math.max(...day_minutes, 1);
    const dayEntries = days.map((d, i) => ({
      label: d.slice(5),
      val: day_minutes[i] || 0,
      pct: Math.round(((day_minutes[i] || 0) / maxD) * 100),
      color: BAR_COLORS[0],
    })).slice(-14); // 只显示最近14天

    const maxT = Math.max(...Object.values(type_minutes), 1);
    const typeEntries = Object.entries(type_minutes).map(([t, m], i) => ({
      label: getTaskType(t).label,
      val: m,
      pct: Math.round((m / maxT) * 100),
      color: BAR_COLORS[i % BAR_COLORS.length],
    }));

    const maxC = Math.max(...Object.values(course_minutes), 1);
    const courseEntries = Object.entries(course_minutes).map(([c, m], i) => ({
      label: c.length > 6 ? c.slice(0, 6) + '…' : c,
      val: m,
      pct: Math.round((m / maxC) * 100),
      color: BAR_COLORS[(i + 2) % BAR_COLORS.length],
    }));

    this.setData({ dayEntries, typeEntries, courseEntries, loading: false });
  },
});
