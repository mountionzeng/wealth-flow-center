import json
import unittest
from datetime import datetime, timedelta, timezone
import urllib.request

from core.environment import (
    CACHE_TTLS,
    EnvironmentGateway,
    EnvironmentProviderConfig,
    EnvironmentProviderError,
    _RejectRedirectHandler,
)


def location(name, admin1, country, latitude, longitude, timezone_name):
    return {
        "name": name,
        "admin1": admin1,
        "country": country,
        "country_code": "CN",
        "latitude": latitude,
        "longitude": longitude,
        "timezone": timezone_name,
    }


class FakeEnvironmentTransport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, config, endpoint, params, timeout, max_bytes):
        self.calls.append(
            {
                "endpoint": endpoint,
                "params": dict(params),
                "timeout": timeout,
                "max_bytes": max_bytes,
            }
        )
        response = self.responses[endpoint]
        if callable(response):
            response = response(params)
        if isinstance(response, Exception):
            raise response
        return response


def environment_responses():
    chengdu = location("成都", "四川", "中国", 30.67, 104.07, "Asia/Shanghai")
    beijing = location("北京", "北京", "中国", 39.90, 116.40, "Asia/Shanghai")
    days = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]
    return {
        "geocoding": lambda params: {
            "results": [chengdu] if params["name"] == "成都" else [beijing]
        },
        "forecast": {
            "timezone": "Asia/Shanghai",
            "current": {
                "time": "2026-08-05T18:00",
                "temperature_2m": 31.2,
                "apparent_temperature": 34.1,
                "relative_humidity_2m": 63,
                "precipitation": 0,
                "weather_code": 2,
                "wind_speed_10m": 18.4,
            },
            "current_units": {
                "temperature_2m": "°C",
                "apparent_temperature": "°C",
                "relative_humidity_2m": "%",
                "precipitation": "mm",
                "weather_code": "wmo code",
                "wind_speed_10m": "km/h",
            },
            "hourly": {
                "time": ["2026-08-05T18:00", "2026-08-05T19:00", "2026-08-05T20:00"],
                "temperature_2m": [31.2, 29.5, 28.0],
                "precipitation_probability": [10, 40, 70],
                "weather_code": [2, 61, 61],
                "wind_speed_10m": [18.4, 24.0, 27.0],
            },
            "hourly_units": {
                "temperature_2m": "°C",
                "precipitation_probability": "%",
                "weather_code": "wmo code",
                "wind_speed_10m": "km/h",
            },
        },
        "air_quality": {
            "timezone": "Asia/Shanghai",
            "current": {
                "time": "2026-08-05T18:00",
                "us_aqi": 117,
                "pm2_5": 41.5,
            },
            "current_units": {"us_aqi": "USAQI", "pm2_5": "μg/m³"},
        },
        "historical": {
            "timezone": "Asia/Shanghai",
            "daily": {
                "time": days,
                "temperature_2m_mean": [28.0, 29.0, 30.0, 29.0],
                "precipitation_sum": [0.0, 2.0, 0.0, 6.0],
                "wind_speed_10m_max": [14.0, 16.0, 18.0, 20.0],
            },
            "daily_units": {
                "temperature_2m_mean": "°C",
                "precipitation_sum": "mm",
                "wind_speed_10m_max": "km/h",
            },
        },
    }


class EnvironmentGatewayTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 8, 5, 10, 0, tzinfo=timezone.utc)

    def test_two_cities_are_normalized_but_only_current_city_gets_environment(self):
        transport = FakeEnvironmentTransport(environment_responses())
        gateway = EnvironmentGateway(transport=transport, now=lambda: self.now)

        snapshot = gateway.build_snapshot("成都", "北京")

        self.assertEqual(snapshot["locations"]["birth"]["selected"]["name"], "成都")
        self.assertEqual(snapshot["locations"]["current"]["selected"]["name"], "北京")
        self.assertEqual(snapshot["environment"]["location"]["name"], "北京")
        self.assertEqual(snapshot["environment"]["current"]["temperature"]["value"], 31.2)
        self.assertEqual(snapshot["environment"]["air_quality"]["aqi"]["value"], 117)
        self.assertEqual(snapshot["environment"]["trend_24h"]["hours"][2]["rain_probability"], 70)
        self.assertEqual(snapshot["environment"]["baseline"]["temperature_mean"]["value"], 29.0)
        self.assertEqual(snapshot["status"], "complete")

        environment_calls = [call for call in transport.calls if call["endpoint"] != "geocoding"]
        self.assertEqual([call["endpoint"] for call in environment_calls], ["forecast", "air_quality", "historical"])
        for call in environment_calls:
            self.assertAlmostEqual(float(call["params"]["latitude"]), 39.90)
            self.assertAlmostEqual(float(call["params"]["longitude"]), 116.40)

        sent = json.dumps(transport.calls, ensure_ascii=False)
        for forbidden in ("甲子", "account", "password", "身体", "学习", "question", "gps"):
            self.assertNotIn(forbidden, sent.lower())

    def test_ambiguous_city_requires_explicit_candidate_confirmation(self):
        responses = environment_responses()
        responses["geocoding"] = {
            "results": [
                location("通州", "北京", "中国", 39.90, 116.66, "Asia/Shanghai"),
                location("通州", "江苏", "中国", 32.06, 121.07, "Asia/Shanghai"),
            ]
        }
        transport = FakeEnvironmentTransport(responses)
        gateway = EnvironmentGateway(transport=transport, now=lambda: self.now)

        pending = gateway.search_city("通州")

        self.assertEqual(pending["status"], "needs_confirmation")
        self.assertEqual(len(pending["candidates"]), 2)
        self.assertEqual([item["admin1"] for item in pending["candidates"]], ["北京", "江苏"])
        self.assertFalse(any(call["endpoint"] != "geocoding" for call in transport.calls))

        selected = gateway.search_city("通州", selected_id=pending["candidates"][0]["id"])
        self.assertEqual(selected["status"], "confirmed")
        self.assertEqual(selected["selected"]["admin1"], "北京")

    def test_qualified_chinese_city_queries_use_city_name_and_region_hint(self):
        responses = environment_responses()
        responses["geocoding"] = lambda params: {
            "results": {
                "攀枝花": [
                    location("攀枝花", "云南", "中国", 26.50, 101.74, "Asia/Shanghai"),
                    location("攀枝花", "四川", "中国", 26.58, 101.72, "Asia/Shanghai"),
                ],
                "通州": [
                    location("通州", "北京市", "中国", 39.90, 116.66, "Asia/Shanghai"),
                    location("通州", "江苏省", "中国", 32.06, 121.07, "Asia/Shanghai"),
                ],
            }.get(params["name"], [])
        }
        transport = FakeEnvironmentTransport(responses)
        gateway = EnvironmentGateway(transport=transport, now=lambda: self.now)

        compact = gateway.search_city("四川攀枝花")
        suffixed = gateway.search_city("四川省攀枝花市")
        spaced = gateway.search_city("北京 通州")

        self.assertEqual(compact["query"], "四川攀枝花")
        self.assertEqual(compact["status"], "confirmed")
        self.assertEqual(compact["selected"]["admin1"], "四川")
        self.assertEqual(suffixed["status"], "confirmed")
        self.assertEqual(suffixed["selected"]["name"], "攀枝花")
        self.assertEqual(spaced["status"], "confirmed")
        self.assertEqual(spaced["selected"]["admin1"], "北京市")
        self.assertEqual(
            [call["params"]["name"] for call in transport.calls],
            ["攀枝花", "通州"],
        )

    def test_partial_provider_data_never_invents_weather_or_air_quality(self):
        responses = environment_responses()
        responses["forecast"] = EnvironmentProviderError("provider_timeout")
        responses["air_quality"] = {"timezone": "Asia/Shanghai", "current": {}}
        transport = FakeEnvironmentTransport(responses)
        gateway = EnvironmentGateway(transport=transport, now=lambda: self.now)

        snapshot = gateway.build_snapshot("成都", "北京")

        self.assertEqual(snapshot["status"], "partial")
        self.assertEqual(snapshot["environment"]["current"]["status"], "missing")
        self.assertEqual(snapshot["environment"]["current"]["reason"], "provider_timeout")
        self.assertEqual(snapshot["environment"]["air_quality"]["status"], "missing")
        self.assertNotIn("temperature", snapshot["environment"]["current"])
        self.assertNotIn("rain", json.dumps(snapshot["environment"]["current"]))

    def test_stale_public_cache_is_labeled_and_history_uses_longer_ttl(self):
        clock = [self.now]
        responses = environment_responses()
        transport = FakeEnvironmentTransport(responses)
        gateway = EnvironmentGateway(transport=transport, now=lambda: clock[0])
        first = gateway.build_snapshot("成都", "北京")
        self.assertEqual(first["status"], "complete")

        clock[0] += CACHE_TTLS["forecast"] + timedelta(seconds=1)
        transport.responses["forecast"] = EnvironmentProviderError("provider_timeout")
        second = gateway.build_snapshot("成都", "北京")

        self.assertEqual(second["environment"]["current"]["status"], "stale")
        self.assertEqual(second["environment"]["current"]["last_updated"], "2026-08-05T10:00:00+00:00")
        self.assertGreater(CACHE_TTLS["historical"], CACHE_TTLS["forecast"])

    def test_low_coverage_baseline_is_missing_without_blocking_current_weather(self):
        responses = environment_responses()
        responses["historical"]["daily"]["temperature_2m_mean"] = [28.0, None, None, None]
        transport = FakeEnvironmentTransport(responses)
        gateway = EnvironmentGateway(transport=transport, now=lambda: self.now)

        snapshot = gateway.build_snapshot("成都", "北京")

        self.assertEqual(snapshot["environment"]["current"]["status"], "available")
        self.assertEqual(snapshot["environment"]["baseline"]["status"], "missing")
        self.assertEqual(snapshot["environment"]["baseline"]["reason"], "insufficient_coverage")
        self.assertEqual(snapshot["status"], "partial")

    def test_unknown_weather_code_and_missing_hourly_values_keep_valid_shape(self):
        responses = environment_responses()
        responses["forecast"]["current"]["weather_code"] = 999
        responses["forecast"]["hourly"]["temperature_2m"][1] = None
        transport = FakeEnvironmentTransport(responses)
        gateway = EnvironmentGateway(transport=transport, now=lambda: self.now)

        snapshot = gateway.build_snapshot("成都", "北京")

        self.assertEqual(snapshot["environment"]["current"]["weather"]["code"], 999)
        self.assertEqual(snapshot["environment"]["current"]["weather"]["label"], "未知天气代码")
        self.assertIsNone(snapshot["environment"]["trend_24h"]["hours"][1]["temperature"])

    def test_endpoint_configuration_rejects_non_https_or_unapproved_hosts(self):
        unsafe_configs = [
            EnvironmentProviderConfig(forecast_url="http://api.open-meteo.com/v1/forecast"),
            EnvironmentProviderConfig(forecast_url="https://tracker.example/v1/forecast"),
        ]
        for config in unsafe_configs:
            with self.subTest(config=config), self.assertRaises(EnvironmentProviderError):
                EnvironmentGateway(config=config, transport=FakeEnvironmentTransport(environment_responses()))

    def test_redirect_handler_rejects_every_target_before_following_it(self):
        handler = _RejectRedirectHandler()
        request = urllib.request.Request("https://api.open-meteo.com/v1/forecast")

        for target in (
            "http://127.0.0.1/private",
            "http://169.254.169.254/latest/meta-data",
            "https://tracker.example/collect",
        ):
            with self.subTest(target=target), self.assertRaisesRegex(
                EnvironmentProviderError,
                "provider_redirect_rejected",
            ):
                handler.redirect_request(request, None, 302, "Found", {}, target)


if __name__ == "__main__":
    unittest.main()
