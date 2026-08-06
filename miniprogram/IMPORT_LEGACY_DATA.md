# 一次性导入本地学习数据

本导入工具会把仓库里的 `study_state.json` 转成小程序云数据库中的 `study_data` 文档，并绑定到当前调用者的微信 openid。

## 1. 部署云函数

在微信开发者工具中：

1. 先部署正式业务云函数：右键 `cloudfunctions/studyApi`，选择「上传并部署：云端安装依赖」。
2. 再部署导入云函数：右键 `cloudfunctions/importLegacyStudyData`，选择「上传并部署：云端安装依赖」。

## 2. 预检查

打开开发者工具的 Console，粘贴：

```js
wx.cloud.callFunction({
  name: 'importLegacyStudyData',
  data: {
    token: 'study-import-2026-05-10'
  }
}).then(console.log)
```

如果返回 `dry_run: true`，并看到任务数量、标签数量、等级等统计，就说明导入文件可用。

## 3. 正式导入

继续在 Console 粘贴：

```js
wx.cloud.callFunction({
  name: 'importLegacyStudyData',
  data: {
    token: 'study-import-2026-05-10',
    confirm: 'IMPORT_LOCAL_STUDY_STATE'
  }
}).then(console.log)
```

成功后会返回 `ok: true`，并显示 `created_new_doc` 或 `updated_existing_doc`。

## 4. 验证

重新编译小程序，进入「任务」「标签」「数据」「本周」页面确认数据已出现。

## 5. 导入后清理

确认导入成功后，建议在云开发控制台删除 `importLegacyStudyData` 云函数，避免一次性导入工具长期保留。
