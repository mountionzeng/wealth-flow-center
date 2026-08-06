# 财富流通中心 iOS

这是「财富流通中心」的原生 iOS 版本骨架，目标是把当前 Web/Python 本地工具改造成可以提交 App Store 的 App。

## 当前已完成

- SwiftUI 原生界面
- 本地 JSON 数据保存
- 创建、完成、删除学习任务
- 课程学习、复习巩固、技能拓展、实践、知识库搭建、做作业
- 最近一个月学习时长可视化
- iOS EventKit 写入苹果日历
- UserNotifications 本地学习提醒
- App Icon 资产目录
- App Store 隐私和提交清单模板

## 需要本机准备

1. 从 Mac App Store 安装完整 Xcode。
2. 打开 Xcode 并完成首次组件安装。
3. 在终端执行：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -version
```

## 打开工程

```bash
open "/Users/yuandai/Documents/New project/study-time-game/ios/WealthFlowCenter/WealthFlowCenter.xcodeproj"
```

在 Xcode 里需要检查：

- `Signing & Capabilities`：选择你的 Apple Developer Team。
- `Bundle Identifier`：当前是 `com.mountion.wealthflowcenter`，如果你的开发者账号已有固定域名命名，可以再改。
- 真机运行：日历权限和本地通知权限需要在真机上测。

## 上架前必须补齐

- App Store Connect 创建 App 记录。
- 隐私政策 URL。
- iPhone 截图，建议至少 6.7 英寸和 6.5 英寸规格。
- App 名称、关键词、描述、支持 URL。
- 日历权限说明和 App 功能描述保持一致。

## 技术说明

当前 iOS 版本先使用本地 JSON 存储，与 Web 版 `study_state.json` 字段保持相近结构。后续如果要多设备同步，建议再接 CloudKit 或线上 API；第一版上架可以先走本地优先，审核风险更低，功能也更闭环。
