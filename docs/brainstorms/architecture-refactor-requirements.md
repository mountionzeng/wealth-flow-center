# 财富流通中心 — 架构重构计划

**日期**: 2026-05-08
**状态**: 草案
**范围**: 全平台（Web / CLI / 微信小程序 / iOS），分 4 阶段执行

---

## 背景

项目功能可用，但存在三个结构性问题：
1. **四平台业务逻辑完全重复且已漂移** — 任务类型数量不一致（CLI 4 种 vs Web 6 种），奖励公式不同（Web `minutes*0.8*mult` vs 小程序 `minutes*10*mult`），升级公式不同（线性 vs 指数），周起始日不同（周一 vs 周日）
2. **存储脆弱** — 单 JSON 文件整体读写，无原子写入保护
3. **代码不可维护** — 1400 行单文件 HTML、手写 HTTP 路由、无测试

所有平台均处于开发阶段，未上线，可以自由重构。

---

## 目标

- 消除跨平台业务逻辑重复，建立单一事实来源
- 确保服务稳定性，数据不丢失
- 让代码结构支持后续迭代而非阻碍它
- 保持每个阶段可独立交付、不破坏现有功能

## 非目标

- 不更换产品形态或核心玩法
- 不做用户系统 / 多用户支持（当前是单用户本地应用）
- 不做自动化 CI/CD
- 不迁移小程序后端到自建服务器（继续用微信云开发）

---

## 阶段 P0：抽取 Core 模块（Python 端统一）

**目的**: 消除 `wealth_center_web.py` 和 `study_game.py` 之间的代码重复，建立 Python 端的单一业务逻辑来源。

### 产出

```
core/
├── __init__.py
├── models.py          # TASK_TYPES 定义、别名映射、常量
├── rewards.py         # quest_reward(), xp_to_next_level(), apply_level_up()
├── stats.py           # week_bounds(), rolling_day_minutes(), type_minutes(),
│                      # course_minutes_recent(), build_week_metrics(),
│                      # weekly_reminders(), update_streak()
├── storage.py         # load_state(), save_state(), migrate_state(), default_state()
│                      # 封装 JSON 读写，预留接口换 SQLite
├── calendar_sync.py   # add_to_calendar(), build_calendar_title(),
│                      # schedule_calendar_sync()
└── quest_ops.py       # create_quest_record(), complete_quest(), delete_quest(),
                       # rebuild_player_from_quests(), create_or_update_tag()
```

### 改动点

- `wealth_center_web.py` 瘦身为纯 HTTP 层，只做路由 + 请求解析 + 调用 core
- `study_game.py` 瘦身为纯 CLI 交互层，只做 input/print + 调用 core
- `desktop_study_overlay.py` 不变（它只调 HTTP API）
- CLI 补齐 2 种任务类型（knowledge, homework），与 Web 一致

### 验收标准

- `wealth_center_web.py` 和 `study_game.py` 中不再有任何奖励计算、升级计算、统计计算代码
- CLI 和 Web 创建同样的任务，产生完全一致的 XP / 财富 / 升级结果
- 现有全部功能不回退

---

## 阶段 P1：存储保护 + 前端拆分

### P1a：存储原子写入

**目的**: 防止 launchd 重启、进程崩溃时数据文件损坏。

改动：
- `storage.py` 中的 `save_state()` 改为先写临时文件再 `os.replace()` 原子替换
- 每次写入前自动保留最近 3 份备份（`study_state.backup.1.json` 等）
- 加进程级文件锁（`fcntl.flock`），防止 CLI 和 Web 同时写

### P1b：前端拆分

**目的**: 让 1400 行的 `web/index.html` 可维护。

改动：
- CSS 抽出到 `web/styles.css`
- React JSX 抽出到 `web/app.jsx`，用 Vite 或 esbuild 预编译，去掉运行时 Babel
- `mobile.html` 同理拆分，或与 `index.html` 合并为响应式单页面
- 删除 `web/index.backup.before_replace.html`（备份文件不应该在仓库中）

### 验收标准

- 模拟 kill -9 进程后，数据文件完整无损
- 前端本地开发有热更新，不再靠浏览器 Babel 实时编译
- `index.html` 体积 < 50 行（仅挂载点 + 脚本引用）

---

## 阶段 P2：Web 框架 + 跨平台公式对齐

### P2a：用 Flask 或 FastAPI 替换 http.server

**目的**: 获得 CORS、错误处理、请求校验、中间件支持。

改动：
- 用 FastAPI（推荐）或 Flask 重写路由层
- 添加 CORS 中间件（桌面悬浮窗和可能的移动端需要跨域访问）
- 统一错误响应格式
- `WealthCenterHandler` 类删除

### P2b：小程序 & iOS 公式对齐

**目的**: 确保所有平台对同一份学习数据产生一致的计算结果。

需对齐的差异（以 Python core 为基准）：

| 项目 | 当前小程序值 | 应对齐到 |
|------|------------|---------|
| 奖励 XP | `minutes * 10 * mult` | `max(20, minutes * 0.8 * mult)` |
| 奖励财富 | `minutes * mult` | `max(2, (minutes/15) * mult)` |
| 升级公式 | `xp_target *= 1.18` 指数增长 | `100 + (level-1) * 40` 线性增长 |
| 周起始日 | 周日 | 周一 |

iOS Swift 端同理对齐。

**做法**: 在 `core/` 旁新建 `docs/formulas.md`，作为跨平台公式的文字规范，小程序和 iOS 参照此文档实现。

### 验收标准

- Web API 支持 CORS，桌面悬浮窗正常调用
- 小程序和 iOS 的奖励/升级/周统计公式与 Python core 一致
- `docs/formulas.md` 完整记录所有业务公式

---

## 阶段 P3：测试 + 存储升级

### P3a：核心逻辑单元测试

**目的**: 为 `core/` 模块建立测试安全网，防止后续改动引入回归。

覆盖范围：
- `rewards.py`：奖励计算、升级公式边界值
- `stats.py`：周边界、连续天数中断/延续、空数据
- `storage.py`：迁移兼容性、原子写入、损坏恢复
- `quest_ops.py`：创建/完成/删除/标签更新

### P3b：JSON → SQLite（可选）

**目的**: 解决数据量增长后 JSON 整体读写的性能问题，支持更灵活的查询。

条件：当任务数超过 200 或出现写入延迟时再做。当前数据量下 JSON 够用。

改动：
- `storage.py` 内部换用 SQLite，对外接口不变
- 数据迁移脚本：`study_state.json` → SQLite

### 验收标准

- `core/` 测试覆盖率 > 80%
- （若做 P3b）现有数据无损迁移到 SQLite

---

## 目录结构终态

```
study-time-game/
├── core/                          # 业务核心（Python）
│   ├── models.py
│   ├── rewards.py
│   ├── stats.py
│   ├── storage.py
│   ├── calendar_sync.py
│   └── quest_ops.py
├── server/                        # Web API
│   └── app.py                     # FastAPI 路由，调用 core
├── cli/                           # CLI
│   └── main.py                    # 交互层，调用 core
├── desktop/                       # 桌面悬浮窗
│   └── overlay.py
├── web/                           # 前端
│   ├── index.html
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/
│   │   └── styles/
│   ├── package.json
│   └── vite.config.js
├── miniprogram/                   # 微信小程序（独立）
├── ios/                           # iOS（独立）
├── deploy/
│   └── launchd/
│       └── com.mountion.wealthcenter4318.plist
├── docs/
│   ├── formulas.md                # 跨平台公式规范
│   └── brainstorms/
├── tests/
│   └── test_core/
├── study_state.json               # 数据文件（gitignore）
└── README.md
```

---

## 风险与注意事项

- **P0 最关键也最安全**：纯代码搬运 + 提取，不改功能逻辑，只要跑通就行
- **P1b 前端拆分引入构建步骤**：需要 Node.js 环境，launchd 部署方式需适配
- **P2a 换框架**：需加 `fastapi` / `uvicorn` 依赖，launchd plist 启动命令需更新
- **小程序公式对齐可能影响已有测试数据**：但既然都在开发中，直接改即可

---

## 建议执行顺序

```
P0（core 抽取）→ P1a（存储保护）→ P1b（前端拆分）→ P2a（Web 框架）→ P2b（公式对齐）→ P3a（测试）
```

P0 和 P1a 可以同一轮做完，因为 `storage.py` 本身就是 P0 抽取的一部分，顺手加原子写入即可。
