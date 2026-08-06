import json
import unittest
from datetime import date, datetime, timezone

from core.bazi import (
    current_jieqi,
    direction_advice,
    parse_bazi,
    solar_term_context,
    today_context,
)


class BaziTests(unittest.TestCase):
    def test_complete_bazi_exposes_only_auditable_visible_element_counts(self):
        parsed = parse_bazi("甲戌 壬申 己丑 丁卯")

        self.assertTrue(parsed["valid"])
        self.assertTrue(parsed["complete"])
        self.assertEqual(parsed["status"], "complete")
        self.assertEqual(
            [pillar["text"] for pillar in parsed["pillars"]],
            ["甲戌", "壬申", "己丑", "丁卯"],
        )
        self.assertEqual(parsed["day_master"], "己")
        self.assertEqual(parsed["day_master_wuxing"], "土")
        self.assertEqual(
            parsed["five_elements"]["counts"],
            {"金": 1, "木": 2, "水": 1, "火": 1, "土": 3},
        )
        self.assertEqual(parsed["five_elements"]["total"], 8)
        self.assertEqual(parsed["five_elements"]["method"], "visible_stems_branches")
        self.assertIn("不含藏干", parsed["five_elements"]["scope"])
        self.assertIn("不判断旺衰", parsed["five_elements"]["scope"])
        self.assertEqual(parsed["algorithm_version"], "bazi-facts-1.0.0")
        self.assertEqual(
            [fact["id"] for fact in parsed["facts"]],
            ["bazi.pillars.visible", "bazi.day_master", "bazi.elements.visible"],
        )

    def test_punctuation_labels_and_repeated_separators_are_normalized(self):
        parsed = parse_bazi("甲子年，，丙寅月 / 壬午日··辛亥时")

        self.assertTrue(parsed["valid"])
        self.assertEqual(parsed["normalized"], "甲子 丙寅 壬午 辛亥")
        self.assertEqual(parsed["day_master"], "壬")

    def test_partial_empty_and_illegal_inputs_are_not_treated_as_complete_bazi(self):
        partial = parse_bazi("甲子 丙寅")
        empty = parse_bazi("  ")
        illegal = parse_bazi("甲X 1234 不是八字")

        self.assertFalse(partial["valid"])
        self.assertFalse(partial["complete"])
        self.assertEqual(partial["status"], "partial")
        self.assertIsNone(partial["day_master"])
        self.assertEqual(partial["five_elements"]["total"], 4)
        self.assertTrue(partial["errors"])
        self.assertEqual(empty["status"], "invalid")
        self.assertEqual(illegal["status"], "invalid")
        self.assertEqual(illegal["pillars"], [])

    def test_more_than_four_pillars_is_rejected_instead_of_silently_truncated(self):
        parsed = parse_bazi("甲子 丙寅 壬午 辛亥 戊辰")

        self.assertFalse(parsed["valid"])
        self.assertEqual(parsed["status"], "invalid")
        self.assertIn("只能包含四柱", "".join(parsed["errors"]))

    def test_impossible_stem_branch_pairs_are_rejected(self):
        parsed = parse_bazi("甲丑 乙子 丙卯 丁寅")

        self.assertFalse(parsed["valid"])
        self.assertEqual(parsed["status"], "invalid")
        self.assertIn("不属于六十甲子", "".join(parsed["errors"]))
        self.assertIn("甲丑", "".join(parsed["errors"]))

    def test_solar_term_boundary_uses_exact_library_time(self):
        before = solar_term_context(
            datetime(2026, 8, 7, 19, 41),
            "Asia/Shanghai",
        )
        after = solar_term_context(
            datetime(2026, 8, 7, 19, 43),
            "Asia/Shanghai",
        )

        self.assertEqual(before["current"]["name"], "大暑")
        self.assertEqual(before["next"]["name"], "立秋")
        self.assertEqual(before["next"]["starts_at"], "2026-08-07T19:42:43+08:00")
        self.assertEqual(after["current"]["name"], "立秋")
        self.assertEqual(after["next"]["name"], "处暑")
        self.assertEqual(after["calendar_version"], "lunar_python@1.4.8")

    def test_same_instant_is_rendered_in_confirmed_current_city_timezone(self):
        context = solar_term_context(
            datetime(2026, 8, 7, 11, 43, tzinfo=timezone.utc),
            "America/Los_Angeles",
        )

        self.assertEqual(context["current"]["name"], "立秋")
        self.assertEqual(context["current"]["starts_at"], "2026-08-07T04:42:43-07:00")
        self.assertEqual(context["local_date"], "2026-08-07")
        self.assertEqual(context["timezone"], "America/Los_Angeles")
        self.assertEqual(context["timezone_source"], "confirmed_current_city")

    def test_invalid_city_timezone_uses_explicit_fallback_source(self):
        context = solar_term_context(
            datetime(2026, 8, 7, 19, 43),
            "Not/A_Timezone",
            fallback_timezone_name="Asia/Shanghai",
            fallback_source="browser_timezone",
        )

        self.assertEqual(context["timezone"], "Asia/Shanghai")
        self.assertEqual(context["timezone_source"], "fallback:browser_timezone")
        self.assertEqual(context["current"]["name"], "立秋")

    def test_compatibility_helpers_use_supplied_date_without_server_timezone(self):
        self.assertEqual(current_jieqi(date(2026, 8, 6))["name"], "大暑")
        context = today_context(date(2026, 8, 5), "Asia/Shanghai")
        directions = direction_advice("水")

        self.assertEqual(context["date"], "2026-08-05")
        self.assertIn("gan", context["day_ganzhi"])
        self.assertIn("current", context["solar_terms"])
        self.assertTrue(directions["lucky"])
        self.assertTrue(directions["avoid"])

    def test_fact_payload_avoids_deterministic_fortune_or_major_decision_language(self):
        payload = json.dumps(
            parse_bazi("甲戌 壬申 己丑 丁卯"),
            ensure_ascii=False,
        )

        for forbidden in ("必然", "灾祸", "绝对相合", "必须迁居", "喜用神"):
            self.assertNotIn(forbidden, payload)


if __name__ == "__main__":
    unittest.main()
