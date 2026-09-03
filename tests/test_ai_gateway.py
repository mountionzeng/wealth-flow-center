import io
import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from PIL import Image

from core.ai_gateway import (
    AIGateway,
    AIProviderError,
    ProviderConfig,
    sanitize_image,
)
from core.daily_advice import build_daily_context, generate_daily_advice, validate_daily_advice
from core.spring_wind import _validate_evidence, generate_spring_wind


class FakeTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def __call__(self, config, payload, timeout):
        self.calls.append((config, payload, timeout))
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def completion(content):
    return {"choices": [{"message": {"content": content}}]}


class AIGatewayTests(unittest.TestCase):
    def config(self):
        return ProviderConfig(
            provider_name="测试服务",
            base_url="https://provider.example/v1",
            api_key="secret-key",
            text_model="text-model",
            vision_model="vision-model",
            retention_policy="不用于训练，保留 0 天",
            terms_version="2026-08-05",
        )

    def test_config_is_loaded_from_berich_environment_only(self):
        values = {
            "BERICH_AI_PROVIDER_NAME": "302.ai",
            "BERICH_AI_BASE_URL": "https://api.302.ai/v1",
            "BERICH_AI_API_KEY": "token",
            "BERICH_AI_TEXT_MODEL": "model-a",
            "BERICH_AI_VISION_MODEL": "model-b",
            "BERICH_AI_RETENTION_POLICY": "请查看供应商条款",
            "BERICH_AI_TERMS_VERSION": "v1",
        }
        with patch.dict(os.environ, values, clear=True):
            config = ProviderConfig.from_env()

        self.assertTrue(config.configured)
        self.assertEqual(config.provider_name, "302.ai")
        self.assertNotIn("token", json.dumps(config.disclosure(), ensure_ascii=False))

    def test_invalid_timeout_configuration_falls_back_without_crashing(self):
        for raw in ("not-a-number", "", "   "):
            with self.subTest(raw=raw), patch.dict(os.environ, {"BERICH_AI_TIMEOUT_SECONDS": raw}, clear=True):
                self.assertEqual(ProviderConfig.from_env().timeout_seconds, 45)
        with patch.dict(os.environ, {"BERICH_AI_TIMEOUT_SECONDS": "999"}, clear=True):
            self.assertEqual(ProviderConfig.from_env().timeout_seconds, 90)

    def test_daily_context_is_allowlisted_and_output_has_exactly_two_suggestions(self):
        response = completion(json.dumps({
            "body": {"title": "舒展肩颈", "reason": "精力偏低", "start_time": "09:30", "duration_minutes": 10},
            "learning": {"title": "复习笔记", "reason": "控制负荷", "start_time": "15:00", "duration_minutes": 25},
        }, ensure_ascii=False))
        transport = FakeTransport(response)
        gateway = AIGateway(self.config(), transport=transport)
        context = build_daily_context(
            {"sleep": "一般", "energy": "低", "mood": "平静", "discomfort": "肩颈", "note": "有点累", "secret": "drop"},
            {"body_minutes": 15, "learning_minutes": 50, "variance_minutes": -20, "feelings": ["drop"]},
            [{"calendar_name": "学习", "title": "读书", "start": "2026-08-04 10:00", "end": "2026-08-04 10:30", "duration_minutes": 30, "location": "drop"}],
        )

        advice = generate_daily_advice(gateway, context)

        self.assertEqual(set(advice), {"body", "learning"})
        self.assertEqual(advice["learning"]["duration_minutes"], 25)
        sent = json.dumps(transport.calls[0][1], ensure_ascii=False)
        self.assertNotIn("secret", sent)
        self.assertNotIn("feelings", sent)
        self.assertNotIn("location", sent)
        self.assertEqual(transport.calls[0][1]["response_format"], {"type": "json_object"})

    def test_invalid_daily_output_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_daily_advice({"body": {"title": "休息"}})

    def test_provider_failures_are_redacted(self):
        transport = FakeTransport(RuntimeError("secret-key 用户八字甲子"))
        gateway = AIGateway(self.config(), transport=transport)

        with self.assertRaisesRegex(AIProviderError, "provider_unavailable") as caught:
            gateway.complete_text("system", "用户八字甲子")

        self.assertNotIn("secret-key", str(caught.exception))
        self.assertNotIn("甲子", str(caught.exception))

    def test_image_is_validated_and_metadata_removed(self):
        source = io.BytesIO()
        image = Image.new("RGB", (24, 16), color=(250, 240, 220))
        image.save(source, format="JPEG", exif=b"Exif\x00\x00metadata")

        sanitized = sanitize_image(source.getvalue(), "image/jpeg")

        self.assertEqual(sanitized.media_type, "image/jpeg")
        cleaned = Image.open(io.BytesIO(sanitized.data))
        self.assertEqual(cleaned.size, (24, 16))
        self.assertFalse(cleaned.getexif())
        self.assertNotIn("icc_profile", cleaned.info)

    def test_spoofed_or_oversized_image_is_rejected(self):
        with self.assertRaises(ValueError):
            sanitize_image(b"<svg><script/></svg>", "image/png")
        with self.assertRaises(ValueError):
            sanitize_image(b"x" * (5 * 1024 * 1024 + 1), "image/jpeg")

    def test_vision_extracts_supported_profile_fields_without_accepting_identity_data(self):
        response = completion(json.dumps({
            "bazi": "甲戌年 壬申月 己丑日 丁卯时",
            "profile_fields": [
                {"key": "gender", "value": "女", "confidence": "high"},
                {"key": "birth_place", "value": "四川成都", "confidence": "medium"},
                {"key": "phone", "value": "13800000000", "confidence": "high"},
            ],
        }, ensure_ascii=False))
        transport = FakeTransport(response)
        gateway = AIGateway(self.config(), transport=transport)
        image = sanitize_image(self._png_bytes(), "image/png")

        recognized = gateway.recognize_bazi(image)

        self.assertEqual(recognized["source"], "external_vision")
        self.assertEqual([item["key"] for item in recognized["profile_fields"]], ["gender", "birth_place"])
        self.assertNotIn("13800000000", json.dumps(recognized, ensure_ascii=False))
        self.assertNotIn("response_format", transport.calls[0][1])

    @staticmethod
    def _png_bytes():
        output = io.BytesIO()
        Image.new("RGB", (12, 12), color=(245, 235, 210)).save(output, format="PNG")
        return output.getvalue()

    def test_spring_wind_keeps_facts_program_owned_and_validates_evidence(self):
        model_output = {
            "culture": {
                "summary": {"text": "传统文化视角下，先看真实环境再作调整。", "evidence_ids": ["calendar.solar_term.current"], "traditional_culture": True},
                "clothing": {"text": "衣着以舒适和便于增减为先。", "evidence_ids": ["bazi.elements.visible", "environment.weather.current"], "traditional_culture": True},
                "direction": {"text": "方位只作散步与采光观察，不作吉凶命令。", "evidence_ids": ["bazi.day_master", "location.current"], "traditional_culture": True},
                "diet": {"text": "饮食宜规律，并按当日体感调整。", "evidence_ids": ["calendar.solar_term.current", "environment.weather.current"], "traditional_culture": True},
                "do_avoid": {"text": "宜把任务拆小，忌用推演代替事实核对。", "evidence_ids": ["history.summary"], "traditional_culture": True},
                "question": {"text": "签约前先核对现实条款。", "evidence_ids": ["history.summary"], "traditional_culture": True},
            },
            "actions": [{
                "kind": "environment", "title": "缩短高强度户外活动",
                "detail": "空气质量较差时，优先选择室内舒缓活动。", "basis": "当前 AQI 事实",
                "evidence_ids": ["environment.air_quality.current"], "observe": "观察实际体感与官方预警",
                "uncertainty": "环境数据会变化，请以最新观测为准", "traditional_culture": False,
            }],
        }
        transport = FakeTransport(completion(json.dumps(model_output, ensure_ascii=False)))
        gateway = AIGateway(self.config(), transport=transport)
        environment = FakeEnvironment(self.environment_snapshot())

        report = generate_spring_wind(
            gateway,
            environment,
            self.spring_wind_request(),
            now=datetime(2026, 8, 5, 12, tzinfo=timezone.utc),
        )

        self.assertEqual(report["version"], "spring-wind-report-2")
        self.assertEqual(report["status"], "complete")
        self.assertEqual(report["facts"][0]["id"], "bazi.pillars.visible")
        self.assertIn("profile.gender", {fact["id"] for fact in report["facts"]})
        self.assertEqual(report["metadata"]["confirmed_profile_fields"], 2)
        self.assertEqual(report["culture"]["clothing"]["traditional_culture"], True)
        self.assertEqual(report["actions"][0]["evidence_ids"], ["environment.air_quality.current"])
        self.assertEqual(report["metadata"]["model"], "text-model")
        sent = json.dumps(transport.calls[0][1], ensure_ascii=False)
        self.assertIn("environment.weather.current", sent)
        self.assertIn("profile.gender", sent)
        self.assertNotIn("password", sent)
        self.assertNotIn("backup", sent)
        self.assertNotIn("projection", sent)

    def test_invalid_model_evidence_and_unsafe_major_decisions_are_removed_without_losing_facts(self):
        invalid = {
            "culture": {
                key: {"text": "传统文化观察。", "evidence_ids": ["unknown.fact"], "traditional_culture": True}
                for key in ("summary", "clothing", "direction", "diet", "do_avoid")
            },
            "actions": [{
                "kind": "daily", "title": "必须迁居", "detail": "这个城市绝对不合。", "basis": "气场测量",
                "evidence_ids": ["location.birth"], "observe": "无", "uncertainty": "无", "traditional_culture": True,
            }],
            "facts": [{"id": "model.temperature", "value": 99}],
        }
        transport = FakeTransport(completion(json.dumps(invalid, ensure_ascii=False)))
        gateway = AIGateway(self.config(), transport=transport)

        report = generate_spring_wind(
            gateway,
            FakeEnvironment(self.environment_snapshot()),
            self.spring_wind_request(question=""),
            now=datetime(2026, 8, 5, 12, tzinfo=timezone.utc),
        )

        self.assertEqual(report["status"], "partial")
        self.assertEqual(report["metadata"]["ai_status"], "invalid")
        self.assertIn("summary", report["culture"])
        self.assertTrue(report["culture"]["summary"]["traditional_culture"])
        self.assertTrue(report["actions"])
        self.assertTrue(all(action["origin"] == "local_rule" for action in report["actions"]))
        self.assertIn("environment.weather.current", {fact["id"] for fact in report["facts"]})
        self.assertNotIn("model.temperature", {fact["id"] for fact in report["facts"]})

    def test_evidence_numbers_require_exact_values_not_substrings(self):
        facts = {
            "environment.weather.current": {
                "id": "environment.weather.current",
                "type": "environment_observation",
                "status": "available",
                "value": {"temperature": {"value": 31}, "change": -1.5},
            }
        }
        allowed = {"environment_observation"}

        self.assertEqual(
            _validate_evidence(
                ["environment.weather.current"],
                facts,
                allowed,
                "当前 31 度，变化 -1.50 度",
            ),
            ["environment.weather.current"],
        )
        for invented in ("当前 1 度", "当前 3 度", "变化 1.5 度"):
            with self.subTest(invented=invented), self.assertRaisesRegex(ValueError, "不存在的数值"):
                _validate_evidence(
                    ["environment.weather.current"],
                    facts,
                    allowed,
                    invented,
                )

    def test_environment_or_ai_failure_returns_explicit_partial_facts_without_invented_weather(self):
        gateway = AIGateway(self.config(), transport=FakeTransport(AIProviderError("provider_unavailable")))
        missing_environment = self.environment_snapshot()
        missing_environment["status"] = "partial"
        missing_environment["environment"]["current"] = {"status": "missing", "reason": "provider_timeout"}
        missing_environment["facts"] = [
            fact for fact in missing_environment["facts"] if fact["id"] != "environment.weather.current"
        ] + [{
            "id": "environment.weather.current", "type": "environment_observation", "value": None,
            "source": "Open-Meteo Forecast", "status": "missing",
        }]

        report = generate_spring_wind(
            gateway,
            FakeEnvironment(missing_environment),
            self.spring_wind_request(),
            now=datetime(2026, 8, 5, 12, tzinfo=timezone.utc),
        )

        self.assertEqual(report["status"], "partial")
        weather = next(fact for fact in report["facts"] if fact["id"] == "environment.weather.current")
        self.assertEqual(weather["status"], "missing")
        self.assertIsNone(weather["value"])
        self.assertEqual(report["metadata"]["ai_status"], "missing")
        self.assertIn("summary", report["culture"])
        self.assertTrue(report["culture"]["summary"]["traditional_culture"])
        self.assertNotIn("正在下雨", json.dumps(report, ensure_ascii=False))

    @staticmethod
    def spring_wind_request(question="今天适合签合同吗？"):
        return {
            "bazi": "甲戌 壬申 己丑 丁卯",
            "birth_city": "成都",
            "current_city": "北京",
            "profile_details": [
                {"key": "gender", "value": "女"},
                {"key": "true_solar_time", "value": "1994-08-31 05:31"},
                {"key": "phone", "value": "13800000000"},
            ],
            "question": question,
            "browser_timezone": "Asia/Shanghai",
            "context": {
                "version": "spring-wind-context-1.0.0",
                "window": {"start": "2026-07-07", "end": "2026-08-05", "days": 30},
                "history_summary": {"completion_count": 2, "actual_minutes": 43, "variance_minutes": -27},
                "manifest": {"included": ["body_history", "learning_history"], "omitted": ["calendar_history"], "samples": {"recent_completions": 2}},
            },
            "consent_manifest": {
                "environment": {"granted": True, "categories": ["birth_city", "current_city"]},
                "ai": {"granted": True, "categories": ["bazi", "profile_details", "birth_city", "current_city", "question", "environment_facts", "history_summary"]},
            },
        }

    @staticmethod
    def environment_snapshot():
        birth = {"id": "birth-1", "name": "成都", "admin1": "四川", "country": "中国", "timezone": "Asia/Shanghai", "latitude": 30.67, "longitude": 104.07}
        current = {"id": "current-1", "name": "北京", "admin1": "北京", "country": "中国", "timezone": "Asia/Shanghai", "latitude": 39.9, "longitude": 116.4}
        weather = {"status": "available", "observed_at": "2026-08-05T20:00", "temperature": {"value": 31, "unit": "°C"}, "wind_speed": {"value": 24, "unit": "km/h"}, "source": "Open-Meteo Forecast"}
        air = {"status": "available", "observed_at": "2026-08-05T20:00", "aqi": {"value": 117, "unit": "USAQI"}, "source": "Open-Meteo Air Quality"}
        return {
            "version": "environment-facts-1.0.0", "status": "complete",
            "provider": {"name": "Open-Meteo", "attribution": "Weather data by Open-Meteo.com"},
            "locations": {"birth": {"status": "confirmed", "selected": birth}, "current": {"status": "confirmed", "selected": current}},
            "environment": {"location": current, "current": weather, "trend_24h": {"status": "available", "hours": []}, "air_quality": air, "baseline": {"status": "available", "temperature_mean": {"value": 29, "unit": "°C"}}},
            "facts": [
                {"id": "location.birth", "type": "normalized_location", "value": birth, "source": "Open-Meteo Geocoding", "status": "available"},
                {"id": "location.current", "type": "normalized_location", "value": current, "source": "Open-Meteo Geocoding", "status": "available"},
                {"id": "environment.weather.current", "type": "environment_observation", "value": weather, "source": "Open-Meteo Forecast", "status": "available"},
                {"id": "environment.air_quality.current", "type": "environment_observation", "value": air, "source": "Open-Meteo Air Quality", "status": "available"},
            ],
        }


class FakeEnvironment:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.calls = []

    def build_snapshot(self, birth_city, current_city, **kwargs):
        self.calls.append((birth_city, current_city, kwargs))
        return self.snapshot


if __name__ == "__main__":
    unittest.main()
