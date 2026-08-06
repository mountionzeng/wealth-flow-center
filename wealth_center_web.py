#!/usr/bin/env python3
"""财富流通中心 Web UI server — thin HTTP layer over core/."""

from __future__ import annotations

import json
import os
import re
import secrets
from html import escape
from datetime import timedelta
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from core.models import TASK_TYPES, TIME_FMT, normalize_task_type, normalize_task_type_for_storage
from core.rewards import quest_reward
from core.stats import format_time, get_minutes, next_half_hour_slot, now_local, parse_time
from core.storage import STATE_LOCK, load_state, save_state
from core.quest_ops import (
    complete_quest,
    create_or_update_tag,
    create_quest_record,
    dashboard_payload,
    delete_quest,
)
from core.calendar_sync import CalendarBridge, CalendarCommandError, schedule_calendar_sync
from core.ai_gateway import AIGateway, AIProviderError, MAX_IMAGE_BYTES, ProviderConfig, sanitize_image
from core.local_vision import LocalVisionError, LocalVisionOCR
from core.daily_advice import build_daily_context, generate_daily_advice
from core.spring_wind import generate_spring_wind
from core.environment import EnvironmentGateway

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "web" / "dist"
STATE_FILE = BASE_DIR / "study_state.json"
DEFAULT_HOST = "127.0.0.1"
MAX_BODY_BYTES = 64 * 1024
CAPABILITY_HEADER = "X-Berich-Capability"
DEFAULT_CONFIG_FILE = Path.home() / "Library" / "Application Support" / "Berich" / "config.env"


class RequestTooLarge(ValueError):
    pass


def load_user_config(path: Path | None = None) -> None:
    """Load the same ignored user config for manual and launchd starts.

    Existing environment values win. Values are deliberately never printed.
    """
    config_path = path or Path(os.environ.get("BERICH_CONFIG_FILE", str(DEFAULT_CONFIG_FILE)))
    try:
        lines = config_path.read_text(encoding="utf-8").splitlines()
    except (FileNotFoundError, OSError, UnicodeError):
        return
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if re.fullmatch(r"[A-Z][A-Z0-9_]{1,63}", key):
            os.environ.setdefault(key, value.strip())


class WealthCenterHandler(BaseHTTPRequestHandler):
    server_version = "WealthCenterHTTP/1.0"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._send_security_headers(no_store=True)
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        data = path.read_bytes()
        is_document = content_type.startswith("text/html")
        if is_document:
            bootstrap = (
                '<meta name="berich-capability" content="{}">'.format(
                    escape(self.server.capability_token, quote=True)
                )
            ).encode("utf-8")
            data = data.replace(b"</head>", bootstrap + b"</head>", 1)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # Asset names are stable (app.js/styles.css), so stale browser caches can
        # otherwise keep old interaction code after a local rebuild.
        self._send_security_headers(no_store=True)
        self.end_headers()
        self.wfile.write(data)

    def _send_security_headers(self, no_store: bool = False) -> None:
        if no_store:
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")

    def _read_json_body(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as exc:
            raise ValueError("Content-Length 不合法") from exc
        if length > MAX_BODY_BYTES:
            raise RequestTooLarge("请求体过大")
        if length <= 0:
            return {}
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("Content-Type 必须是 application/json")
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("请求体必须是 JSON 对象")
            return value
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体必须是 JSON")

    def _read_binary_body(self) -> tuple[bytes, str]:
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError as exc:
            raise ValueError("Content-Length 不合法") from exc
        if length > MAX_IMAGE_BYTES:
            raise RequestTooLarge("图片不能超过 5 MB")
        if length <= 0:
            raise ValueError("图片内容为空")
        media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("图片内容不完整")
        return raw, media_type

    def _authorized_bridge_request(self) -> bool:
        expected_host = f"{self.server.server_address[0]}:{self.server.server_address[1]}"
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        fetch_site = self.headers.get("Sec-Fetch-Site", "")
        token = self.headers.get(CAPABILITY_HEADER, "")
        origin_ok = origin == f"http://{expected_host}" or (self.command == "GET" and not origin)
        return (host == expected_host and origin_ok and fetch_site == "same-origin" and secrets.compare_digest(token, self.server.capability_token))

    def _require_bridge_auth(self) -> bool:
        if self._authorized_bridge_request():
            return True
        self._send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": "bridge_access_denied"})
        return False

    def _read_json_or_error(self) -> Any:
        try:
            return self._read_json_body()
        except RequestTooLarge as exc:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": str(exc)})
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
        return None

    def _ai_disclosure(self) -> dict[str, Any]:
        provider = dict(self.server.ai_gateway.disclosure())
        external_vision = bool(provider.get("vision_available"))
        local_vision = bool(self.server.local_vision.available())
        provider.update({
            "text_provider_name": provider.get("provider_name", "未配置"),
            "vision_provider_name": "Mac 本机识别" if local_vision else provider.get("provider_name", "未配置"),
            "external_vision_available": external_vision,
            "local_vision_available": local_vision,
            "vision_available": local_vision or external_vision,
            "vision_mode": "local" if local_vision else "external" if external_vision else "unavailable",
        })
        if local_vision:
            provider["vision_retention_policy"] = "图片只在这台 Mac 临时处理，识别后立即删除，不发送到外部服务"
        return provider

    def _environment_disclosure(self) -> dict[str, Any]:
        return {
            "provider_name": self.server.environment_gateway.config.provider_name,
            "available": True,
            "data_scope": "只接收城市查询或已确认城市的经纬度，不接收八字、账户、问题或个人历史",
            "attribution": "Weather data by Open-Meteo.com",
            "terms_url": "https://open-meteo.com/en/terms",
            "fields_version": "environment-v1",
        }

    _STATIC_TYPES: dict[str, str] = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".map": "application/json",
    }

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
            return
        if path == "/mobile":
            self._send_file(STATIC_DIR / "index.html", "text/html; charset=utf-8")
            return
        if path == "/api/health":
            self._send_json(200, {"ok": True, "service": "wealth-center"})
            return
        if path == "/api/state":
            if not self._require_bridge_auth():
                return
            with STATE_LOCK:
                state = load_state(STATE_FILE)
            self._send_json(200, {"ok": True, "data": dashboard_payload(state)})
            return
        if path == "/api/capability":
            if self._require_bridge_auth():
                self._send_json(200, {"ok": True, "bridge": "loopback", "calendar": True, "ai": True, "environment": True})
            return
        if path == "/api/ai/disclosure":
            if self._require_bridge_auth():
                self._send_json(200, {"ok": True, "provider": self._ai_disclosure()})
            return
        if path == "/api/environment/disclosure":
            if self._require_bridge_auth():
                self._send_json(200, {"ok": True, "provider": self._environment_disclosure()})
            return
        if path == "/api/calendar/calendars":
            if self._require_bridge_auth():
                result = self.server.calendar_bridge.list_calendars()
                self._send_json(200, {"ok": result.get("status") == "succeeded", **result})
            return

        # Serve static assets (css, js, sourcemaps)
        if not path.startswith("/api/"):
            clean = path.lstrip("/")
            candidate = STATIC_DIR / clean
            if candidate.is_file() and candidate.suffix in self._STATIC_TYPES:
                resolved = candidate.resolve()
                if str(resolved).startswith(str(STATIC_DIR.resolve())):
                    self._send_file(resolved, self._STATIC_TYPES[candidate.suffix])
                    return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/calendar/"):
            if not self._require_bridge_auth():
                return
            self._handle_calendar_post(path)
            return

        if path.startswith("/api/ai/"):
            if not self._require_bridge_auth():
                return
            self._handle_ai_post(path)
            return

        if path.startswith("/api/environment/"):
            if not self._require_bridge_auth():
                return
            self._handle_environment_post(path)
            return

        # Legacy mutations can trigger Calendar writes and therefore share the
        # same loopback capability boundary.
        if not self._require_bridge_auth():
            return

        if path == "/api/quests":
            self._handle_create_quest()
            return

        tag_match = re.fullmatch(r"/api/tags/(\d+)/create", path)
        if tag_match:
            self._handle_create_from_tag(int(tag_match.group(1)))
            return

        match = re.fullmatch(r"/api/quests/(\d+)/complete", path)
        if match:
            self._handle_complete_quest(int(match.group(1)))
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PATCH(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if not self._require_bridge_auth():
            return
        match = re.fullmatch(r"/api/quests/(\d+)", path)
        if match:
            self._handle_update_quest(int(match.group(1)))
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if not self._require_bridge_auth():
            return
        match = re.fullmatch(r"/api/quests/(\d+)", path)
        if match:
            self._handle_delete_quest(int(match.group(1)))
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _handle_calendar_post(self, path: str) -> None:
        body = self._read_json_or_error()
        if body is None:
            return
        try:
            if path == "/api/calendar/history":
                names = body.get("calendars", [])
                if not isinstance(names, list):
                    raise ValueError("calendars 必须是数组")
                events = self.server.calendar_bridge.history([str(name) for name in names], days=30)
                self._send_json(200, {"ok": True, "status": "succeeded", "events": events})
                return
            if path == "/api/calendar/events":
                result = self.server.calendar_bridge.write_event(str(body.get("kind", "")), str(body.get("title", "")), datetime.fromisoformat(str(body.get("start", ""))), datetime.fromisoformat(str(body.get("end", ""))), str(body.get("operation_id", "")))
                self._send_json(200, {"ok": result.get("status") == "succeeded", **result})
                return
            if path == "/api/calendar/reconcile":
                result = self.server.calendar_bridge.reconcile(str(body.get("kind", "")), str(body.get("operation_id", "")))
                self._send_json(200, {"ok": result.get("status") == "succeeded", **result})
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except CalendarCommandError as exc:
            self._send_json(503, {"ok": False, "status": exc.status})
        except (ValueError, TypeError):
            self._send_json(400, {"ok": False, "error": "请求参数不合法"})

    def _handle_ai_post(self, path: str) -> None:
        try:
            if path == "/api/ai/recognize-bazi":
                raw, media_type = self._read_binary_body()
                image = sanitize_image(raw, media_type)
                result = self.server.local_vision.recognize_bazi(image) if self.server.local_vision.available() else self.server.ai_gateway.recognize_bazi(image)
                self._send_json(200, {"ok": True, "data": result})
                return

            body = self._read_json_body()
            if path == "/api/ai/daily-advice":
                check_in = body.get("check_in") if isinstance(body.get("check_in"), dict) else {}
                actual_summary = body.get("actual_summary") if isinstance(body.get("actual_summary"), dict) else {}
                events = body.get("calendar_events") if isinstance(body.get("calendar_events"), list) else []
                context = build_daily_context(check_in, actual_summary, events)
                advice = generate_daily_advice(self.server.ai_gateway, context)
                self._send_json(200, {"ok": True, "advice": advice})
                return
            if path == "/api/ai/spring-wind":
                report = generate_spring_wind(
                    self.server.ai_gateway,
                    self.server.environment_gateway,
                    body,
                )
                self._send_json(200, {"ok": True, "report": report})
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except RequestTooLarge as exc:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": str(exc)})
        except AIProviderError as exc:
            self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"ok": False, "error": str(exc)})
        except LocalVisionError as exc:
            self._send_json(HTTPStatus.UNPROCESSABLE_ENTITY, {"ok": False, "error": str(exc)})
        except (ValueError, TypeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "请求参数不合法"})

    def _handle_environment_post(self, path: str) -> None:
        body = self._read_json_or_error()
        if body is None:
            return
        try:
            if path == "/api/environment/search":
                result = self.server.environment_gateway.search_city(
                    str(body.get("query", "")),
                    selected_id=str(body.get("selected_id") or "") or None,
                )
                self._send_json(200, {"ok": True, "location": result})
                return
            self.send_error(HTTPStatus.NOT_FOUND)
        except (ValueError, TypeError):
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "请求参数不合法"})

    def _handle_create_quest(self) -> None:
        try:
            body = self._read_json_body()
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
            return

        title = str(body.get("title", "")).strip()
        course_name = str(body.get("course_name", "")).strip()
        task_type = normalize_task_type(body.get("task_type", "course"))
        start_raw = str(body.get("start", "")).strip()
        end_raw = str(body.get("end", "")).strip()
        write_calendar = bool(body.get("write_calendar", True))

        if not title:
            self._send_json(400, {"ok": False, "error": "任务标题不能为空"})
            return
        if task_type not in TASK_TYPES:
            self._send_json(
                400,
                {"ok": False, "error": "任务类型不合法，可选：课程学习 / 复习巩固 / 技能拓展 / 实践 / 知识库搭建 / 做作业"},
            )
            return

        try:
            start = parse_time(start_raw)
            end = parse_time(end_raw)
        except ValueError:
            self._send_json(400, {"ok": False, "error": f"时间格式必须是 {TIME_FMT}"})
            return

        if end <= start:
            self._send_json(400, {"ok": False, "error": "结束时间必须晚于开始时间"})
            return

        with STATE_LOCK:
            state = load_state(STATE_FILE)
            quest = create_quest_record(
                state=state,
                task_type=task_type,
                course_name=course_name,
                title=title,
                start=start,
                end=end,
                write_calendar=write_calendar,
                touch_tag=True,
            )
            save_state(state, STATE_FILE)
            payload = dashboard_payload(state)
            quest_id = int(quest["id"])

        if write_calendar:
            schedule_calendar_sync(quest_id, STATE_FILE)

        self._send_json(
            201,
            {
                "ok": True,
                "message": "任务创建成功，日历正在后台同步",
                "quest_id": quest_id,
                "data": payload,
            },
        )

    def _handle_create_from_tag(self, tag_id: int) -> None:
        try:
            body = self._read_json_body()
        except ValueError:
            body = {}

        write_calendar = bool(body.get("write_calendar", True))
        start_raw = str(body.get("start", "")).strip()

        with STATE_LOCK:
            state = load_state(STATE_FILE)
            tag = next((t for t in state.get("quick_tags", []) if int(t.get("id", 0)) == tag_id), None)
            if tag is None:
                self._send_json(404, {"ok": False, "error": "找不到这个标签"})
                return

            if start_raw:
                try:
                    start = parse_time(start_raw)
                except ValueError:
                    self._send_json(400, {"ok": False, "error": f"时间格式必须是 {TIME_FMT}"})
                    return
            else:
                start = next_half_hour_slot()

            duration = max(10, int(tag.get("duration_minutes", 60)))
            end = start + timedelta(minutes=duration)

            quest = create_quest_record(
                state=state,
                task_type=normalize_task_type_for_storage(tag.get("task_type", "course")),
                course_name=str(tag.get("course_name", "")),
                title=str(tag.get("title", "")),
                start=start,
                end=end,
                write_calendar=write_calendar,
                touch_tag=True,
            )
            save_state(state, STATE_FILE)
            payload = dashboard_payload(state)
            quest_id = int(quest["id"])

        if write_calendar:
            schedule_calendar_sync(quest_id, STATE_FILE)

        self._send_json(
            201,
            {
                "ok": True,
                "message": "已根据标签创建复习任务",
                "quest_id": quest_id,
                "start": format_time(start),
                "end": format_time(end),
                "data": payload,
            },
        )

    def _handle_update_quest(self, quest_id: int) -> None:
        try:
            body = self._read_json_body()
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
            return

        with STATE_LOCK:
            state = load_state(STATE_FILE)
            target = next((q for q in state["quests"] if int(q.get("id", 0)) == quest_id), None)
            if target is None:
                self._send_json(404, {"ok": False, "error": "找不到任务"})
                return
            if target.get("status") == "done":
                self._send_json(400, {"ok": False, "error": "已完成任务不支持修改"})
                return

            title = str(body.get("title", target.get("title", ""))).strip()
            course_name = str(body.get("course_name", target.get("course_name", ""))).strip()
            target_task_type = normalize_task_type_for_storage(target.get("task_type", "course"))
            task_type = normalize_task_type(body.get("task_type", target_task_type))
            start_raw = str(body.get("start", target.get("start", ""))).strip()
            end_raw = str(body.get("end", target.get("end", ""))).strip()
            write_calendar = bool(body.get("write_calendar", False))

            if not title:
                self._send_json(400, {"ok": False, "error": "任务标题不能为空"})
                return
            if task_type not in TASK_TYPES:
                self._send_json(
                    400,
                    {"ok": False, "error": "任务类型不合法，可选：课程学习 / 复习巩固 / 技能拓展 / 实践 / 知识库搭建 / 做作业"},
                )
                return
            try:
                start = parse_time(start_raw)
                end = parse_time(end_raw)
            except ValueError:
                self._send_json(400, {"ok": False, "error": f"时间格式必须是 {TIME_FMT}"})
                return
            if end <= start:
                self._send_json(400, {"ok": False, "error": "结束时间必须晚于开始时间"})
                return

            minutes = get_minutes(start, end)
            reward_xp, reward_wealth = quest_reward(minutes, task_type)

            target["title"] = title
            target["course_name"] = course_name
            target["task_type"] = task_type
            target["start"] = format_time(start)
            target["end"] = format_time(end)
            target["duration_minutes"] = minutes
            target["reward_xp"] = reward_xp
            target["reward_wealth"] = reward_wealth
            target["updated_at"] = format_time(now_local())
            if write_calendar:
                target["calendar_sync_status"] = "pending"
                target["calendar_sync_message"] = ""
            else:
                target["calendar_sync_message"] = "已修改（未改动已有日历事件）"

            create_or_update_tag(
                state=state,
                task_type=task_type,
                course_name=course_name,
                title=title,
                duration_minutes=minutes,
                event_time=target["updated_at"],
            )

            save_state(state, STATE_FILE)
            payload = dashboard_payload(state)

        if write_calendar:
            schedule_calendar_sync(quest_id, STATE_FILE)

        self._send_json(
            200,
            {
                "ok": True,
                "message": "任务已修改",
                "quest_id": quest_id,
                "data": payload,
            },
        )

    def _handle_delete_quest(self, quest_id: int) -> None:
        with STATE_LOCK:
            state = load_state(STATE_FILE)
            removed = delete_quest(state, quest_id)
            if removed is None:
                self._send_json(404, {"ok": False, "error": "找不到任务"})
                return

            save_state(state, STATE_FILE)
            payload = dashboard_payload(state)

        self._send_json(
            200,
            {
                "ok": True,
                "message": "任务已删除",
                "deleted": {
                    "id": int(removed.get("id", 0)),
                    "status": str(removed.get("status", "todo")),
                },
                "data": payload,
            },
        )

    def _handle_complete_quest(self, quest_id: int) -> None:
        with STATE_LOCK:
            state = load_state(STATE_FILE)
            target = next((q for q in state["quests"] if int(q.get("id", 0)) == quest_id), None)
            if target is None:
                self._send_json(404, {"ok": False, "error": "找不到任务"})
                return
            if target.get("status") == "done":
                self._send_json(400, {"ok": False, "error": "任务已经完成"})
                return

            complete_quest(state, quest_id)
            save_state(state, STATE_FILE)
            payload = dashboard_payload(state)

        self._send_json(200, {"ok": True, "message": "任务已完成", "data": payload})

    def log_message(self, fmt: str, *args: Any) -> None:
        return


def create_server(
    host: str = DEFAULT_HOST,
    port: int = 4318,
    capability_token: str | None = None,
    calendar_bridge: CalendarBridge | None = None,
    ai_gateway: AIGateway | None = None,
    local_vision: LocalVisionOCR | None = None,
    environment_gateway: EnvironmentGateway | None = None,
) -> ThreadingHTTPServer:
    if host != DEFAULT_HOST:
        raise ValueError("本机桥只允许绑定 127.0.0.1")
    server = ThreadingHTTPServer((host, port), WealthCenterHandler)
    server.capability_token = capability_token or secrets.token_urlsafe(32)
    server.calendar_bridge = calendar_bridge or CalendarBridge()
    server.ai_gateway = ai_gateway or AIGateway(ProviderConfig.from_env())
    server.local_vision = local_vision or LocalVisionOCR()
    server.environment_gateway = environment_gateway or EnvironmentGateway()
    return server


def run(host: str = DEFAULT_HOST, port: int = 4318) -> None:
    if not STATIC_DIR.exists():
        raise SystemExit(f"Missing static dir: {STATIC_DIR}")
    load_user_config()
    server = create_server(host, port)
    print(f"Wealth Center running at http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()
