App({
  onLaunch() {
    wx.cloud.init({
      traceUser: true,
    });
  },
  globalData: {
    state: null,
  },
});
