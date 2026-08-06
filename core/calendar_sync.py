"""Bounded, injectable macOS Calendar integration via static AppleScript."""

from __future__ import annotations

import json
import subprocess
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .stats import parse_time
from .storage import STATE_LOCK, load_state, save_state

PLAN_CALENDAR_NAME = "Berich · 计划"
RECORD_CALENDAR_NAME = "Berich · 记录"
STUDY_CALENDAR_NAME = PLAN_CALENDAR_NAME
MAX_VALUE_LENGTH = 500
MAX_OUTPUT_BYTES = 256 * 1024
COMMAND_TIMEOUT_SECONDS = 8
_COMMAND_SLOTS = threading.BoundedSemaphore(2)

LIST_SCRIPT = r'''on run argv
tell application "Calendar" to return name of every calendar
end run'''

HISTORY_SCRIPT = r'''on run argv
set startBound to date (item 1 of argv)
set endBound to date (item 2 of argv)
set wantedNames to items 3 thru -1 of argv
set rows to {}
tell application "Calendar"
repeat with calendarName in wantedNames
set targetCalendar to calendar (calendarName as text)
repeat with eventItem in (every event of targetCalendar whose start date >= startBound and start date <= endBound)
set end of rows to (calendarName as text) & tab & (summary of eventItem as text) & tab & ((start date of eventItem) as «class isot» as string) & tab & ((end date of eventItem) as «class isot» as string)
end repeat
end repeat
end tell
set AppleScript's text item delimiters to linefeed
return rows as text
end run'''

WRITE_SCRIPT = r'''on run argv
set calendarName to item 1 of argv
set eventTitle to item 2 of argv
set startTime to date (item 3 of argv)
set endTime to date (item 4 of argv)
set operationMarker to item 5 of argv
tell application "Calendar"
if not (exists calendar calendarName) then make new calendar with properties {name:calendarName}
set targetCalendar to calendar calendarName
set newEvent to make new event at end of events of targetCalendar with properties {summary:eventTitle, start date:startTime, end date:endTime, description:operationMarker}
return "OK" & tab & (uid of newEvent as text)
end tell
end run'''

RECONCILE_SCRIPT = r'''on run argv
set calendarName to item 1 of argv
set operationMarker to item 2 of argv
set startBound to date (item 3 of argv)
set endBound to date (item 4 of argv)
tell application "Calendar"
if not (exists calendar calendarName) then return "0"
set matches to every event of calendar calendarName whose description is operationMarker and start date >= startBound and start date <= endBound
return (count of matches) as text
end tell
end run'''


class CalendarCommandError(RuntimeError):
    def __init__(self, status: str, message: str = "Calendar operation failed") -> None:
        super().__init__(message)
        self.status = status


def _validate(value: str, label: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_VALUE_LENGTH:
        raise ValueError(f"{label}不合法")
    if any(ord(char) < 32 and char not in "\t\n" for char in value):
        raise ValueError(f"{label}包含控制字符")
    return value


def _status_from_stderr(stderr: str) -> str:
    lowered = stderr.lower()
    if any(word in lowered for word in ("not authorized", "not permitted", "-1743", "permission")):
        return "permission_denied"
    return "retryable_failure"


class CalendarBridge:
    def __init__(self, runner: Callable[..., Any] = subprocess.run, now: Callable[[], datetime] = datetime.now) -> None:
        self.runner = runner
        self.now = now

    def _run(self, script: str, args: Iterable[str], write: bool = False) -> str:
        command = ["osascript", "-e", script, "--", *[_validate(str(value), "参数") for value in args]]
        if not _COMMAND_SLOTS.acquire(blocking=False):
            raise CalendarCommandError("retryable_failure", "Calendar busy")
        try:
            try:
                result = self.runner(command, capture_output=True, text=True, check=False, timeout=COMMAND_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired as exc:
                raise CalendarCommandError("ambiguous" if write else "retryable_failure", "Calendar timeout") from exc
            except OSError as exc:
                raise CalendarCommandError("unavailable", "Calendar unavailable") from exc
        finally:
            _COMMAND_SLOTS.release()
        stdout = str(result.stdout or "")
        stderr = str(result.stderr or "")
        if len(stdout.encode("utf-8")) > MAX_OUTPUT_BYTES or len(stderr.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise CalendarCommandError("ambiguous" if write else "retryable_failure", "Calendar output too large")
        if result.returncode:
            raise CalendarCommandError(_status_from_stderr(stderr))
        return stdout.strip()

    def list_calendars(self) -> dict[str, Any]:
        try:
            output = self._run(LIST_SCRIPT, [])
            names = [name.strip() for name in output.replace(", ", "\n").splitlines() if name.strip()]
            return {"status": "succeeded", "calendars": sorted(set(names))}
        except CalendarCommandError as exc:
            return {"status": exc.status, "calendars": []}

    def history(self, names: list[str], days: int = 30, available_calendars: Optional[list[str]] = None) -> list[dict[str, Any]]:
        if days != 30:
            raise ValueError("历史窗口固定为 30 天")
        if available_calendars is None:
            listed = self.list_calendars()
            if listed["status"] != "succeeded":
                raise CalendarCommandError(listed["status"])
            available_calendars = listed["calendars"]
        selected = sorted(set(_validate(name, "日历名称") for name in names))
        if any(name not in available_calendars for name in selected):
            raise ValueError("包含未授权的日历")
        end = self.now().replace(microsecond=0)
        start = end - timedelta(days=30)
        output = self._run(HISTORY_SCRIPT, [start.isoformat(), end.isoformat(), *selected])
        if not output:
            return []
        try:
            raw_events = json.loads(output)
        except json.JSONDecodeError:
            rows = [row.split("\t") for row in output.splitlines()]
            if any(len(row) != 4 for row in rows):
                raise CalendarCommandError("retryable_failure", "Malformed Calendar output")
            raw_events = [dict(zip(("calendar_name", "title", "start", "end"), row)) for row in rows]
        if not isinstance(raw_events, list) or any(not isinstance(item, dict) for item in raw_events):
            raise CalendarCommandError("retryable_failure", "Malformed Calendar output")
        events = []
        for item in raw_events:
            if not isinstance(item, dict) or not isinstance(item.get("calendar_name"), str) or not item["calendar_name"].strip():
                raise CalendarCommandError("retryable_failure", "Malformed Calendar output")
            if item["calendar_name"] not in selected:
                continue
            try:
                calendar_name = item["calendar_name"]
                title = item["title"]
                start_raw = item["start"]
                end_raw = item["end"]
                if not all(isinstance(value, str) and value.strip() for value in (calendar_name, title, start_raw, end_raw)):
                    raise ValueError("Calendar event fields must be non-empty strings")
                event_start = datetime.fromisoformat(start_raw.replace("Z", "+00:00"))
                event_end = datetime.fromisoformat(end_raw.replace("Z", "+00:00"))
                duration = int((event_end - event_start).total_seconds() // 60)
                if duration < 0:
                    raise ValueError("Calendar event ends before it starts")
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                raise CalendarCommandError("retryable_failure", "Malformed Calendar output") from exc
            events.append({"calendar_name": calendar_name, "title": title, "start": start_raw, "end": end_raw, "duration_minutes": duration})
        return sorted(events, key=lambda item: (item["start"], item["calendar_name"], item["title"]))

    def write_event(self, kind: str, title: str, start: datetime, end: datetime, operation_id: str) -> dict[str, Any]:
        if kind not in ("plan", "record") or end <= start:
            raise ValueError("事件参数不合法")
        marker = "berich-operation:" + _validate(operation_id, "operation_id")
        calendar_name = PLAN_CALENDAR_NAME if kind == "plan" else RECORD_CALENDAR_NAME
        try:
            output = self._run(WRITE_SCRIPT, [calendar_name, _validate(title, "标题"), start.replace(microsecond=0).isoformat(), end.replace(microsecond=0).isoformat(), marker], write=True)
            parts = output.split("\t")
            return {"status": "succeeded", "event_id": parts[1] if len(parts) > 1 else None, "operation_id": operation_id}
        except CalendarCommandError as exc:
            return {"status": exc.status, "operation_id": operation_id}

    def reconcile(self, kind: str, operation_id: str) -> dict[str, Any]:
        if kind not in ("plan", "record"):
            raise ValueError("事件类型不合法")
        calendar_name = PLAN_CALENDAR_NAME if kind == "plan" else RECORD_CALENDAR_NAME
        try:
            now = self.now().replace(microsecond=0)
            count = int(self._run(RECONCILE_SCRIPT, [calendar_name, "berich-operation:" + _validate(operation_id, "operation_id"), (now - timedelta(days=30)).isoformat(), (now + timedelta(days=365)).isoformat()]) or "0")
        except (CalendarCommandError, ValueError) as exc:
            return {"status": exc.status if isinstance(exc, CalendarCommandError) else "retryable_failure", "operation_id": operation_id}
        return {"status": "succeeded" if count == 1 else "retryable_failure" if count == 0 else "ambiguous", "operation_id": operation_id, "matches": count}


DEFAULT_BRIDGE = CalendarBridge()


def escape_applescript_string(value: str) -> str:
    """Legacy compatibility; new scripts never interpolate dynamic values."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def add_to_calendar(title: str, start: datetime, end: datetime) -> tuple[bool, str]:
    operation_id = f"legacy-{int(datetime.now().timestamp() * 1000000)}"
    result = DEFAULT_BRIDGE.write_event("plan", title, start, end, operation_id)
    return result["status"] == "succeeded", result["status"]


def build_calendar_title(task_type: str, course_name: str, title: str) -> str:
    return f"{course_name.strip()} - {title.strip()}" if course_name.strip() else title.strip()


def _calendar_sync_job(quest_id: int, state_file: Path) -> None:
    with STATE_LOCK:
        state = load_state(state_file)
        target = next((q for q in state["quests"] if int(q.get("id", 0)) == quest_id), None)
        if target is None:
            return
        target["calendar_sync_status"] = "syncing"
        target["calendar_sync_message"] = ""
        values = (str(target.get("start", "")), str(target.get("end", "")), str(target.get("task_type", "course")), str(target.get("course_name", "")), str(target.get("title", "")))
        save_state(state, state_file)
    try:
        start, end = parse_time(values[0]), parse_time(values[1])
        result = DEFAULT_BRIDGE.write_event("plan", build_calendar_title(values[2], values[3], values[4]), start, end, f"legacy-quest-{quest_id}")
        status = result["status"]
    except Exception:
        status = "retryable_failure"
    with STATE_LOCK:
        state = load_state(state_file)
        target = next((q for q in state["quests"] if int(q.get("id", 0)) == quest_id), None)
        if target is not None:
            target["calendar_sync_status"] = "done" if status == "succeeded" else status
            target["calendar_sync_message"] = status
            save_state(state, state_file)


def schedule_calendar_sync(quest_id: int, state_file: Path) -> None:
    threading.Thread(target=_calendar_sync_job, args=(quest_id, state_file), daemon=True).start()
