---
title: "Multi-Platform Core Module Extraction and Frontend Build Splitting"
date: 2026-05-08
category: architecture-patterns
module: core architecture
problem_type: architecture_pattern
component: development_workflow
severity: medium
applies_when:
  - "Multiple platform surfaces (web, CLI) duplicate the same business logic"
  - "A single monolithic server file exceeds ~1000 lines with mixed concerns"
  - "Frontend ships inline CSS, JSX, and runtime transpilation (e.g. in-browser Babel)"
  - "No atomic write guarantees exist for file-based persistence"
  - "Adding a new feature requires changes in two or more copies of the same logic"
tags:
  - module-extraction
  - code-deduplication
  - atomic-writes
  - frontend-splitting
  - esbuild
  - python-packaging
  - monolith-decomposition
  - file-persistence
---

# Multi-Platform Core Module Extraction and Frontend Build Splitting

## Context

A multi-platform study time tracking gamification app ("财富流通中心") had grown organically into a set of monolithic files with duplicated business logic across surfaces:

- A 1198-line web server (`wealth_center_web.py`) with HTTP routing, business logic, data persistence, and calendar integration all inlined together
- A 637-line CLI (`study_game.py`) that copy-pasted formulas from the web server, leading to drift: 4 task types vs the web's 6, different reward multipliers
- A 1423-line `index.html` with inline CSS, JSX components, and runtime Babel compilation
- No atomic writes — a crash mid-save could corrupt the JSON state file
- Zero module separation making it impossible to unit test business logic or reuse it across entry points

The friction was threefold: bugs fixed in one surface (web) did not propagate to the other (CLI), the risk of data loss was real, and no developer could confidently modify one area without understanding the entire file.

## Guidance

**Extract a shared `core/` package that owns all business logic, making each entry point (web server, CLI, future mobile API) a thin adapter layer.**

The decomposition follows a specific layering:

### 1. Models & Constants (`core/models.py`)
Single source of truth for domain types, enumerations, and normalization functions. Every entry point imports from here rather than defining its own constants.

```python
TASK_TYPES: dict[str, dict[str, Any]] = {
    "course": {"label": "课程学习", "calendar_tag": "课程", "xp_mult": 1.0, "wealth_mult": 1.0},
    "review": {"label": "复习巩固", "calendar_tag": "复习", "xp_mult": 1.2, "wealth_mult": 1.1},
    "skill":  {"label": "技能拓展", ...},
    "practice": {"label": "实践", ...},
    "knowledge": {"label": "知识库搭建", ...},
    "homework": {"label": "做作业", ...},
}
```

### 2. Pure Computation (`core/rewards.py`, `core/stats.py`)
Stateless functions for reward/XP/leveling formulas, streak calculation, and time utilities. These are trivially testable with no I/O dependencies.

```python
def quest_reward(minutes: int, task_type: str) -> tuple[int, int]:
    conf = TASK_TYPES.get(task_type, TASK_TYPES["course"])
    xp = max(20, int(minutes * 0.8 * conf["xp_mult"]))
    wealth = max(2, int((minutes / 15) * conf["wealth_mult"]))
    return xp, wealth

def xp_to_next_level(level: int) -> int:
    return 100 + (level - 1) * 40
```

### 3. Persistence (`core/storage.py`)
Atomic file operations using the rename pattern, backup rotation, and data migration. This is the only module that touches the filesystem for state.

```python
def save_state(state: dict[str, Any], state_file: Path) -> None:
    data = json.dumps(state, ensure_ascii=False, indent=2)
    tmp_path = state_file.with_suffix(".tmp")
    tmp_path.write_text(data, encoding="utf-8")
    os.replace(str(tmp_path), str(state_file))  # atomic on POSIX
```

### 4. Operations (`core/quest_ops.py`)
CRUD operations that compose models + persistence + computation. These represent use cases (create quest, complete quest, build dashboard payload).

### 5. Integration (`core/calendar_sync.py`)
External system adapters (AppleScript calendar integration) isolated behind a clean interface.

### 6. Frontend Build Pipeline
Split inline HTML into separate concerns with a build step:

- `web/styles.css` — extracted CSS (457 lines)
- `web/src/App.jsx` — extracted JSX with ES module imports (947 lines)
- `web/index.html` — slim 15-line shell
- `web/package.json` — esbuild config replacing runtime Babel

```json
{
  "scripts": {
    "build": "esbuild src/App.jsx --bundle --minify --outfile=app.js --target=es2020",
    "dev": "esbuild src/App.jsx --bundle --outfile=app.js --target=es2020 --watch --sourcemap"
  }
}
```

## Why This Matters

**Following this pattern:**
- Eliminates formula drift between surfaces — one fix applies everywhere
- Enables unit testing of business logic without spinning up a server or mocking I/O
- Reduces each file to a single cognitive concern (a developer modifying the CLI never needs to understand HTTP; a developer fixing XP math never needs to understand either)
- Atomic writes prevent data corruption that was previously a real risk
- New entry points (mobile API, scheduled jobs) become trivial — just import `core/`

**Ignoring this pattern:**
- Every new surface multiplies the maintenance burden linearly
- Bug fixes require N-way synchronization across files with no compiler or type system enforcing consistency
- Data corruption risk compounds over time as more write paths exist
- Testing requires integration-level setup for what should be pure function verification

The reduction from 1198+637=1835 lines of duplicated logic to a single ~400-line core package with two thin adapters totaling ~500 lines represents a 70%+ reduction in logic-bearing code surface area.

## When to Apply

- **Multiple entry points share business logic** — web + CLI, API + worker, server + script
- **A single file exceeds ~300 lines of mixed concerns** — routing interleaved with computation interleaved with persistence
- **Formula drift has already been observed** — different surfaces producing different results for the same input
- **You need to add tests but cannot** — because business logic is entangled with I/O or framework code
- **A new entry point is planned** — extract the core before building the new surface, not after

Does NOT apply when:
- The application genuinely has a single entry point with no prospect of another
- The total codebase is under ~200 lines with simple logic

## Examples

**Before — Reward calculation duplicated with drift:**

```python
# wealth_center_web.py (inlined, 6 task types)
xp = max(20, int(minutes * 0.8 * xp_mult))
wealth = max(2, int((minutes / 15) * wealth_mult))

# study_game.py (inlined, only 4 task types, different multipliers)
xp = max(20, int(minutes * 0.8))  # no per-type multiplier!
wealth = max(2, int(minutes / 15))
```

**After — Single source of truth in `core/rewards.py`:**

```python
from core.models import TASK_TYPES

def quest_reward(minutes: int, task_type: str) -> tuple[int, int]:
    conf = TASK_TYPES.get(task_type, TASK_TYPES["course"])
    xp = max(20, int(minutes * 0.8 * conf["xp_mult"]))
    wealth = max(2, int((minutes / 15) * conf["wealth_mult"]))
    return xp, wealth
```

**Before — Non-atomic persistence:**

```python
with open("study_state.json", "w") as f:
    json.dump(state, f, ensure_ascii=False, indent=2)
# crash here = corrupted or empty file
```

**After — Atomic write with backup rotation:**

```python
def save_state(state: dict[str, Any], state_file: Path) -> None:
    data = json.dumps(state, ensure_ascii=False, indent=2)
    tmp_path = state_file.with_suffix(".tmp")
    tmp_path.write_text(data, encoding="utf-8")
    os.replace(str(tmp_path), str(state_file))
```

**Before — 1423-line monolithic HTML:**

```html
<html>
<head>
<style>/* 457 lines of CSS */</style>
</head>
<body>
<div id="root"></div>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/babel-standalone@7/babel.min.js"></script>
<script type="text/babel">
// 947 lines of JSX, compiled at runtime in the browser
</script>
</body>
</html>
```

**After — Separated concerns with build pipeline:**

```
web/
├── index.html          # 15 lines — slim shell
├── styles.css          # 457 lines — extracted CSS
├── src/App.jsx         # 947 lines — ES module imports, esbuild-compiled
├── package.json        # esbuild build/dev scripts
├── app.js              # generated bundle (gitignored)
└── app.js.map          # sourcemap (gitignored)
```

## Related

- `docs/brainstorms/architecture-refactor-requirements.md` — Original refactoring plan with phased approach (P0-P3)
