import unittest

from core.local_vision import extract_bazi_from_observations, extract_profile_from_observations


class LocalVisionTests(unittest.TestCase):
    def test_extracts_four_pillars_from_aligned_stem_and_branch_rows(self):
        observations = [
            {"text": "天干", "x": 0.05, "y": 0.72},
            {"text": "甲", "x": 0.25, "y": 0.72},
            {"text": "壬", "x": 0.45, "y": 0.72},
            {"text": "己", "x": 0.65, "y": 0.72},
            {"text": "丁", "x": 0.85, "y": 0.72},
            {"text": "地支", "x": 0.05, "y": 0.65},
            {"text": "戌", "x": 0.25, "y": 0.65},
            {"text": "申", "x": 0.45, "y": 0.65},
            {"text": "丑", "x": 0.65, "y": 0.65},
            {"text": "卯", "x": 0.85, "y": 0.65},
            {"text": "甲己合化土", "x": 0.15, "y": 0.12},
        ]

        self.assertEqual(
            extract_bazi_from_observations(observations),
            "甲戌年 壬申月 己丑日 丁卯时",
        )

    def test_falls_back_to_four_inline_pillars(self):
        observations = [{"text": "命盘：甲戌 壬申 己丑 丁卯", "x": 0.1, "y": 0.7}]
        self.assertEqual(
            extract_bazi_from_observations(observations),
            "甲戌年 壬申月 己丑日 丁卯时",
        )

    def test_calculates_pillars_from_recognized_true_solar_time(self):
        observations = [{"text": "真太阳时：1994年08月31日 05:45", "x": 0.04, "y": 0.82}]
        self.assertEqual(
            extract_bazi_from_observations(observations),
            "甲戌年 壬申月 己丑日 丁卯时",
        )

    def test_extracts_only_explicitly_labelled_profile_rows(self):
        observations = [
            {"text": "性别：女", "x": 0.05, "y": 0.90},
            {"text": "真太阳时⑦：1994年08月31日 05:31◎", "x": 0.05, "y": 0.82},
            {"text": "出生地：四川成都", "x": 0.05, "y": 0.74},
            {"text": "手机号：13800000000", "x": 0.05, "y": 0.66},
            {"text": "山头火", "x": 0.25, "y": 0.44},
            {"text": "剑锋金", "x": 0.45, "y": 0.44},
            {"text": "霹雳火", "x": 0.65, "y": 0.44},
            {"text": "炉中火", "x": 0.85, "y": 0.44},
        ]

        fields = extract_profile_from_observations(observations)

        self.assertEqual([item["key"] for item in fields], ["gender", "true_solar_time", "birth_place", "nayin"])
        self.assertEqual(fields[1]["value"], "1994年08月31日 05:31")
        self.assertEqual(fields[3]["value"], "山头火 · 剑锋金 · 霹雳火 · 炉中火")
        self.assertNotIn("13800000000", str(fields))


if __name__ == "__main__":
    unittest.main()
