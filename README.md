# 财富流通中心

把时间当作本金，也把身体当作每天要关照的底盘。网站现在把学习积累、身体签到和“问春风”放进同一个本地优先空间。

## 为什么叫「财富流通中心」

这个名字来自一个核心想法：
**希望把“时间财富”流通成只会复利的“知识财富”。**

时间花掉就回不来，但知识会积累、会复用、会放大，越学越值钱。

## 功能概览

- 四个一级栏目：今日、问春风、知识、我的
- 今日流程：身体签到 → 一养一学 → 确认计划 → 记录真实执行 → 改进下一次建议
- “问春风”把八字键入、TXT 与图片拖放合并在同一个输入面；识别结果仍可编辑
- 出生城市用于成长地域背景，现居城市用于实时天气、AQI、24 小时趋势、近 30 日环境基线和节气时区
- 新版报告固定为“可验证事实 → 传统文化解读 → 今日行动”，每条行动可查看证据、来源时间和不确定性
- 支持 6 类学习：课程学习、复习巩固、技能拓展、实践、知识库搭建、做作业
- 学习任务支持创建、完成、修改、删除；新完成按真实时长计算 XP、财富值和统计
- 用户明确确认后，计划写入 `Berich · 计划`；真实完成记录写入 `Berich · 记录`
- 只读取用户在“我的”中明确选择的日历，历史接口只返回日历名、标题、开始、结束和时长
- 复习快捷标签：一键按历史时长创建下一次复习任务
- 学习可视化：最近 1 个月学习时长、学习类型分布、每周学习大纲
- 任务与倒计时表：统一查看任务状态、日历同步状态和剩余时间
- 桌面悬浮提醒（系统级）：显示本次学习剩余、未学习时长、当前任务、下次学习

## 运行环境

- macOS（用于苹果日历写入）
- Python 3.9+
- Node.js 18+（构建 React 静态资源）

## 快速开始

```bash
cd "/Users/yuandai/Documents/New project/study-time-game"
cd web && npm install && npm run build && cd ..
python3 -m pip install -r requirements.txt
python3 wealth_center_web.py
```

启动后访问：`http://127.0.0.1:4318`

首次确认写入日历时，macOS 可能弹出授权窗口。未确认建议、生成报告或打开页面都不会创建日历事件。

AI 是可选项。未配置或失败时，“问春风”仍会保留可用的程序事实与有证据的本地基础提示，不会虚构实时天气；“今日”仍可使用本地基础建议。若要配置兼容 OpenAI Chat Completions 的服务，把 `.env.example` 中的键复制到：

```text
~/Library/Application Support/Berich/config.env
```

请先核实供应商的数据保留与训练条款；网站会按“今日建议、问春风文本、城市环境、图片识别”四个用途分别征求一次同意，接收方、字段类别或条款版本变化后会重新询问，可在“我的”撤回。

## 问春风的数据来源

- 八字事实只统计用户输入的显性天干与地支，不含藏干，不判断旺衰、强弱或用神；方法与算法版本会随报告保存。
- 节气时间由固定版本 `lunar_python==1.4.8` 计算，并按已确认现居城市的 IANA 时区显示。
- 城市规范化、天气、空气质量与近期环境基线通过可替换的 Open-Meteo 适配器获取，页面显示供应商、观测/更新时间和 `available / stale / missing` 状态。
- 环境供应商只收到城市查询或规范坐标，不会收到八字、问题、账户、身体、学习或日历内容。
- 经授权发送给 AI 的个人上下文只含最近 30 天的有界细节和全部历史数字汇总；所选 Apple 日历仍只保留名称、标题、开始、结束与时长五个字段。
- AI 只能生成解释与行动并引用程序事实 ID，不能创建或覆盖事实卡。环境或 AI 不可用时报告会显示 `partial`，不会把推测伪装成实时情况。

本地自动测试全部使用 fake transport，不访问真实天气、Calendar 或 AI。若手动检查公开环境接口，请只使用非敏感测试城市，不要把真实八字或个人历史用于网络连通性测试。

## CLI 模式

```bash
cd "/Users/yuandai/Documents/New project/study-time-game"
python3 study_game.py
```

## 桌面悬浮提醒

先启动 Web 服务，再启动悬浮窗：

```bash
cd "/Users/yuandai/Documents/New project/study-time-game"
python3 wealth_center_web.py
python3 desktop_study_overlay.py
```

## 项目结构

- `wealth_center_web.py`：Web 服务与 API
- `web/src/`：React 前端源码
- `web/dist/`：本地服务和静态托管使用的构建产物（不提交）
- `core/calendar_sync.py`：Apple Calendar 本机桥
- `core/ai_gateway.py`：不落盘的 AI 适配器
- `core/bazi.py`：可复核的八字显性事实与精确节气
- `core/environment.py`：只处理城市级公开环境数据的可替换适配器
- `core/spring_wind.py`：事实快照、证据引用和部分失败编排
- `miniprogram/`：微信小程序版本，可导入微信开发者工具
- `study_game.py`：CLI 版本
- `desktop_study_overlay.py`：系统级桌面悬浮提醒
- `study_state.json`：本地数据文件
- `ios/WealthFlowCenter`：准备上架 App Store 的 SwiftUI iOS 版本骨架

## 数据与隐私边界

- Web 账户、密码摘要、学习记录、身体签到、建议和“问春风”报告按账户保存在当前浏览器 `localStorage`，服务器不建立用户数据库。
- 本地账户只是同一浏览器里的便捷隔离，不是加密保险箱；清除站点数据会删除记录，请先在“我的”中备份。
- 备份导入会保留个人记录，但清除设备相关的日历选择、事件 ID、同步成功状态和 AI 同意记录。
- CLI、桌面悬浮窗等旧界面仍使用 `study_state.json`；它与浏览器账户数据是两条独立的数据路径。
- 图片优先使用这台 Mac 的本机 Vision；仅在本机识别不可用且用户单独授权时，才会在内存中校验、清除元数据并临时发送，不写入浏览器账户或 Python 服务文件。
- 本地账户、资料、用途授权和报告按账户隔离，但仍是浏览器明文便利存储，不抵御恶意同源脚本、恶意软件或能读取浏览器资料的人。
- 养身建议是一般生活关照，不构成诊断、治疗或医疗意见；地域“气场”只作传统文化观察，不是科学测量，不构成迁居、投资或其他重大决策依据。

## 微信小程序上架版本

小程序工程位于：

```bash
open "/Users/yuandai/Documents/New project/study-time-game/miniprogram"
```

发布前需要：

1. 在 `miniprogram/project.config.json` 中填入真实小程序 AppID。
2. 在微信开发者工具中导入 `miniprogram/` 目录。
3. 打开云开发，创建或选择正式环境。
4. 创建数据库集合 `study_data`。
5. 右键 `cloudfunctions/studyApi`，选择「上传并部署：云端安装依赖」。
6. 真机预览并确认任务创建、完成、删除、标签、统计和本周页面可用。

更多发布文字和后台操作见 `miniprogram/RELEASE_CHECKLIST.md`、`miniprogram/SUBMISSION_COPY.md` 与 `miniprogram/PRIVACY_POLICY.md`。

## iOS 上架版本

iOS 工程位于：

```bash
open "/Users/yuandai/Documents/New project/study-time-game/ios/WealthFlowCenter/WealthFlowCenter.xcodeproj"
```

需要先安装完整 Xcode，并在 Xcode 中选择 Apple Developer Team 后再进行真机测试、归档和上传。
