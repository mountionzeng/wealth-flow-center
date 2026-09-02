import http.client
import io
import json
import threading
import unittest
from types import SimpleNamespace

from PIL import Image

import wealth_center_web


class FakeBridge:
    def list_calendars(self):
        return {"status": "succeeded", "calendars": ["工作"]}

    def history(self, names, days=30):
        return []

    def write_event(self, kind, title, start, end, operation_id):
        return {"status": "succeeded", "event_id": "1", "operation_id": operation_id}

    def reconcile(self, kind, operation_id):
        return {"status": "succeeded", "operation_id": operation_id}


class FakeAI:
    def __init__(self):
        self.config = SimpleNamespace(text_model="fixture-model")
        self.json_calls = []
        self.text_calls = []

    def disclosure(self):
        return {"provider_name": "测试服务", "text_available": True, "vision_available": True, "retention_policy": "测试期间不保留", "terms_version": "test-v1"}

    def complete_json(self, system, user, max_tokens=900):
        self.json_calls.append(user)
        if "知识笔记增补" in system:
            return {
                "addition_markdown": "新素材补充了时间尺度这一观察维度。",
                "change_summary": "增加时间尺度与反馈延迟的联系。",
                "review_cards": [{"question": "时间尺度为什么重要？", "answer": "延迟可能掩盖反馈。"}],
            }
        if "知识复习卡" in system:
            return {"review_cards": [{"question": "反馈延迟会怎样？", "answer": "它可能掩盖因果。"}]}
        if "问春风" in system:
            return {
                "culture": {
                    "summary": {"text": "传统文化视角，先核对事实。", "evidence_ids": ["calendar.solar_term.current"], "traditional_culture": True},
                    "clothing": {"text": "衣着以舒适、便于增减为先。", "evidence_ids": ["bazi.elements.visible", "environment.weather.current"], "traditional_culture": True},
                    "direction": {"text": "方位只作散步观察。", "evidence_ids": ["bazi.day_master", "location.current"], "traditional_culture": True},
                    "diet": {"text": "饮食规律并观察体感。", "evidence_ids": ["calendar.solar_term.current"], "traditional_culture": True},
                    "do_avoid": {"text": "宜拆小任务，忌把推演当事实。", "evidence_ids": ["history.summary"], "traditional_culture": True},
                },
                "actions": [{
                    "kind": "daily", "title": "先核对事实", "detail": "根据现有记录安排一件可完成的小事。",
                    "basis": "最近记录汇总", "evidence_ids": ["history.summary"], "observe": "观察完成后的真实感受",
                    "uncertainty": "样本较少时只作轻量参考", "traditional_culture": False,
                }],
            }
        return {
            "body": {"title": "肩颈舒展", "reason": "今日精力偏低", "start_time": "10:00", "duration_minutes": 10},
            "learning": {"title": "复习一页笔记", "reason": "控制知识负荷", "start_time": "15:00", "duration_minutes": 25},
        }

    def complete_text(self, system, user, max_tokens=1800):
        self.text_calls.append(user)
        return """## 问春风\n\n### 今日穿衣指南\n青色。\n\n### 吉凶方位\n东方。\n\n### 饮食建议\n有节。\n\n### 今日宜忌\n宜从容。\n\n> 仅供参考，不构成任何决策依据。"""

    def recognize_bazi(self, image):
        return {"bazi": "甲子 丙寅 壬午 辛亥"}


class FakeLocalVision:
    def __init__(self):
        self.calls = []

    def available(self):
        return True

    def recognize_bazi(self, image):
        self.calls.append(image)
        return {"bazi": "甲子 丙寅 壬午 辛亥", "source": "macos_vision"}


class FakeEnvironment:
    def __init__(self):
        self.search_calls = []
        self.snapshot_calls = []
        self.birth = {"id": "birth-1", "name": "成都", "admin1": "四川", "country": "中国", "timezone": "Asia/Shanghai"}
        self.current = {"id": "current-1", "name": "北京", "admin1": "北京", "country": "中国", "timezone": "Asia/Shanghai"}

    def search_city(self, query, selected_id=None):
        self.search_calls.append((query, selected_id))
        place = self.birth if query == "成都" else self.current
        return {"query": query, "status": "confirmed", "candidates": [place], "selected": place, "provider": "Open-Meteo Geocoding"}

    def build_snapshot(self, birth_city, current_city, **kwargs):
        self.snapshot_calls.append((birth_city, current_city, kwargs))
        weather = {"status": "available", "observed_at": "2026-08-05T18:00", "temperature": {"value": 31, "unit": "°C"}, "source": "Open-Meteo Forecast"}
        return {
            "version": "environment-facts-1.0.0", "status": "complete",
            "provider": {"name": "Open-Meteo", "attribution": "Weather data by Open-Meteo.com"},
            "locations": {"birth": {"status": "confirmed", "selected": self.birth}, "current": {"status": "confirmed", "selected": self.current}},
            "environment": {"current": weather, "trend_24h": {"status": "available", "hours": []}, "air_quality": {"status": "available", "aqi": {"value": 42, "unit": "USAQI"}}, "baseline": {"status": "available", "temperature_mean": {"value": 29, "unit": "°C"}}},
            "facts": [
                {"id": "location.birth", "type": "normalized_location", "value": self.birth, "source": "Open-Meteo Geocoding", "status": "available"},
                {"id": "location.current", "type": "normalized_location", "value": self.current, "source": "Open-Meteo Geocoding", "status": "available"},
                {"id": "environment.weather.current", "type": "environment_observation", "value": weather, "source": "Open-Meteo Forecast", "status": "available"},
            ],
        }


class FakeObsidian:
    def __init__(self):
        self.writes = []

    def list_vaults(self):
        return {"active_vault_id": "vault-1", "vaults": [{"id": "vault-1", "name": "硕士课程知识库", "path": "/tmp/vault", "active": True}]}

    def tree(self, vault_id):
        return {"vault": {"id": vault_id, "name": "硕士课程知识库"}, "files": [{"path": "课程/第一课.md", "name": "第一课"}], "truncated": False}

    def read(self, vault_id, path):
        return {"vault_id": vault_id, "vault_name": "硕士课程知识库", "path": path, "title": "第一课", "content": "原文", "content_hash": "hash-1", "obsidian_url": "obsidian://open?vault=x&file=y"}

    def write(self, vault_id, path, content, expected_hash):
        self.writes.append((vault_id, path, content, expected_hash))
        return {"vault_id": vault_id, "path": path, "content": content, "content_hash": "hash-2"}


class WebBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fake_ai = FakeAI()
        cls.fake_local_vision = FakeLocalVision()
        cls.fake_environment = FakeEnvironment()
        cls.fake_obsidian = FakeObsidian()
        cls.server = wealth_center_web.create_server("127.0.0.1", 0, capability_token="test-token", calendar_bridge=FakeBridge(), ai_gateway=cls.fake_ai, local_vision=cls.fake_local_vision, environment_gateway=cls.fake_environment, obsidian_bridge=cls.fake_obsidian)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        headers = dict(headers or {})
        if body is not None:
            body = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        return response.status, response.getheaders(), data

    def auth(self):
        return {"Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}", "Sec-Fetch-Site": "same-origin", "X-Berich-Capability": "test-token"}

    def test_html_bootstraps_token_without_cache(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(dict(headers).get("Cache-Control"), "no-store")
        self.assertIn(b'test-token', body)
        self.assertNotIn(b'window.__BERICH_BOOTSTRAP__', body)
        self.assertNotIn("script-src 'self' 'unsafe-inline'", dict(headers).get("Content-Security-Policy", ""))

    def test_static_assets_are_never_served_from_a_stale_browser_cache(self):
        status, headers, _ = self.request("GET", "/app.js")
        self.assertEqual(status, 200)
        self.assertEqual(dict(headers).get("Cache-Control"), "no-store")

    def test_calendar_route_requires_complete_same_origin_proof(self):
        for headers in ({}, {"X-Berich-Capability": "test-token"}, {**self.auth(), "Host": "evil.test"}, {**self.auth(), "Origin": "null"}, {**self.auth(), "Sec-Fetch-Site": "cross-site"}):
            status, _, _ = self.request("GET", "/api/calendar/calendars", headers=headers)
            self.assertEqual(status, 403)
        status, _, body = self.request("GET", "/api/calendar/calendars", headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["calendars"], ["工作"])

    def test_same_origin_get_without_origin_header_uses_fetch_metadata_and_capability(self):
        headers = {
            "Host": f"127.0.0.1:{self.port}",
            "Sec-Fetch-Site": "same-origin",
            "X-Berich-Capability": "test-token",
        }
        status, _, body = self.request("GET", "/api/ai/disclosure", headers=headers)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["provider"]["local_vision_available"])

    def test_legacy_state_route_uses_the_same_loopback_capability_boundary(self):
        self.assertEqual(self.request("GET", "/api/state")[0], 403)
        status, _, body = self.request("GET", "/api/state", headers=self.auth())
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

    def test_malformed_and_oversized_json_are_rejected(self):
        headers = self.auth()
        headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request("POST", "/api/calendar/history", body=b"{", headers=headers)
        self.assertEqual(connection.getresponse().status, 400)
        connection.close()
        status, _, _ = self.request("POST", "/api/calendar/history", {"padding": "x" * (wealth_center_web.MAX_BODY_BYTES + 1)}, headers=self.auth())
        self.assertEqual(status, 413)

    def test_write_route_and_legacy_calendar_write_require_token(self):
        event = {"kind": "plan", "title": "阅读", "start": "2026-08-05T09:00:00", "end": "2026-08-05T10:00:00", "operation_id": "op-1"}
        self.assertEqual(self.request("POST", "/api/calendar/events", event)[0], 403)
        quest = {"title": "阅读", "task_type": "course", "start": "2026-08-05 09:00", "end": "2026-08-05 10:00", "write_calendar": True}
        self.assertEqual(self.request("POST", "/api/quests", quest)[0], 403)

    def test_default_bind_is_loopback(self):
        self.assertEqual(wealth_center_web.DEFAULT_HOST, "127.0.0.1")

    def test_ai_routes_require_capability_and_expose_disclosure(self):
        self.assertEqual(self.request("GET", "/api/ai/disclosure")[0], 403)
        status, _, body = self.request("GET", "/api/ai/disclosure", headers=self.auth())
        self.assertEqual(status, 200)
        provider = json.loads(body)["provider"]
        self.assertEqual(provider["provider_name"], "测试服务")
        self.assertEqual(provider["vision_provider_name"], "Mac 本机识别")
        self.assertTrue(provider["local_vision_available"])
        self.assertEqual(provider["vision_mode"], "local")

    def test_daily_and_spring_wind_routes_use_purpose_limited_inputs(self):
        daily = {
            "check_in": {"sleep": 2, "energy": 2, "mood": 3, "discomfort": "肩颈", "note": "晚睡", "secret": "drop"},
            "actual_summary": {"body_minutes": 10, "learning_minutes": 20, "variance_minutes": -5, "feelings": "drop"},
            "calendar_events": [{"calendar_name": "学习", "title": "读书", "start": "2026-08-05 10:00", "end": "2026-08-05 10:30", "duration_minutes": 30, "location": "drop"}],
        }
        status, _, body = self.request("POST", "/api/ai/daily-advice", daily, headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(set(json.loads(body)["advice"]), {"body", "learning"})
        sent = self.fake_ai.json_calls[-1]
        self.assertNotIn("secret", sent)
        self.assertNotIn("feelings", sent)
        self.assertNotIn("location", sent)

        spring_request = {
            "bazi": "甲戌 壬申 己丑 丁卯", "birth_city": "成都", "current_city": "北京", "question": "",
            "browser_timezone": "Asia/Shanghai",
            "context": {"history_summary": {"completion_count": 2}, "manifest": {"included": ["learning_history"], "samples": {"recent_completions": 2}}},
            "consent_manifest": {
                "environment": {"granted": True, "categories": ["birth_city", "current_city"]},
                "ai": {"granted": True, "categories": ["bazi", "birth_city", "current_city", "environment_facts", "history_summary"]},
            },
        }
        status, _, body = self.request("POST", "/api/ai/spring-wind", spring_request, headers=self.auth())
        self.assertEqual(status, 200)
        report = json.loads(body)["report"]
        self.assertEqual(report["version"], "spring-wind-report-2")
        self.assertEqual(report["status"], "complete")
        self.assertIn("clothing", report["culture"])
        self.assertEqual(self.fake_environment.snapshot_calls[-1][0:2], ("成都", "北京"))

    def test_knowledge_refine_returns_an_addition_without_replacing_the_note(self):
        request = {
            "note": {"title": "系统思考", "content": "反馈回路影响行为。"},
            "material": {"label": "课程第三讲", "text": "延迟让反馈不易察觉。"},
        }
        self.assertEqual(self.request("POST", "/api/ai/knowledge-refine", request)[0], 403)
        status, _, body = self.request("POST", "/api/ai/knowledge-refine", request, headers=self.auth())
        self.assertEqual(status, 200)
        result = json.loads(body)["result"]
        self.assertIn("时间尺度", result["addition_markdown"])
        self.assertNotIn("merged_note", result)
        self.assertEqual(result["source_label"], "课程第三讲")

    def test_knowledge_cards_are_generated_without_writing_the_obsidian_note(self):
        status, _, body = self.request(
            "POST",
            "/api/ai/knowledge-cards",
            {"note": {"title": "系统思考", "content": "反馈延迟会掩盖因果。"}},
            headers=self.auth(),
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["result"]["review_cards"][0]["question"], "反馈延迟会怎样？")

    def test_obsidian_routes_auto_list_read_and_write_through_the_local_boundary(self):
        self.assertEqual(self.request("GET", "/api/obsidian/vaults")[0], 403)
        status, _, body = self.request("GET", "/api/obsidian/vaults", headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["active_vault_id"], "vault-1")

        status, _, body = self.request("POST", "/api/obsidian/tree", {"vault_id": "vault-1"}, headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["data"]["files"][0]["path"], "课程/第一课.md")

        status, _, body = self.request("POST", "/api/obsidian/read", {"vault_id": "vault-1", "path": "课程/第一课.md"}, headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["data"]["content"], "原文")

        status, _, body = self.request("POST", "/api/obsidian/write", {"vault_id": "vault-1", "path": "课程/第一课.md", "content": "新内容", "expected_hash": "hash-1"}, headers=self.auth())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["data"]["content_hash"], "hash-2")
        self.assertEqual(self.fake_obsidian.writes[-1], ("vault-1", "课程/第一课.md", "新内容", "hash-1"))

    def test_environment_search_requires_capability_and_receives_city_only(self):
        self.assertEqual(self.request("POST", "/api/environment/search", {"query": "通州"})[0], 403)
        status, _, body = self.request(
            "POST", "/api/environment/search",
            {"query": "成都", "selected_id": None, "bazi": "不应发送"},
            headers=self.auth(),
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["location"]["selected"]["name"], "成都")
        self.assertEqual(self.fake_environment.search_calls[-1], ("成都", None))

    def test_bazi_image_route_accepts_only_sanitized_supported_image(self):
        output = io.BytesIO()
        Image.new("RGB", (12, 12), color=(245, 235, 210)).save(output, format="PNG")
        headers = self.auth()
        headers["Content-Type"] = "image/png"
        connection = http.client.HTTPConnection("127.0.0.1", self.port)
        connection.request("POST", "/api/ai/recognize-bazi", body=output.getvalue(), headers=headers)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body)["data"]["bazi"], "甲子 丙寅 壬午 辛亥")
        self.assertEqual(json.loads(body)["data"]["source"], "macos_vision")
        self.assertEqual(len(self.fake_local_vision.calls), 1)


if __name__ == "__main__":
    unittest.main()
