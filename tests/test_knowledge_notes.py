import unittest
from types import SimpleNamespace

from core.knowledge_notes import generate_knowledge_cards, refine_knowledge_note


class FakeGateway:
    def __init__(self, result):
        self.result = result
        self.calls = []
        self.config = SimpleNamespace(text_model="fixture")

    def complete_json(self, system, user, max_tokens=900):
        self.calls.append((system, user, max_tokens))
        return self.result


class KnowledgeNoteTests(unittest.TestCase):
    def test_returns_only_an_additive_section_and_cards(self):
        gateway = FakeGateway({
            "addition_markdown": "延迟会掩盖反馈，应同时记录时间尺度。",
            "change_summary": "新增了反馈延迟的观察角度。",
            "review_cards": [{"question": "延迟有什么影响？", "answer": "可能掩盖反馈。"}],
        })
        result = refine_knowledge_note(gateway, {
            "note": {"title": "系统思考", "content": "反馈回路影响行为。"},
            "material": {"label": "课程第三讲", "text": "延迟让反馈不易察觉。"},
        })
        self.assertEqual(result["source_label"], "课程第三讲")
        self.assertIn("延迟", result["addition_markdown"])
        self.assertEqual(len(result["review_cards"]), 1)
        self.assertIn("不是重写", gateway.calls[0][0])

    def test_rejects_missing_existing_note_or_material(self):
        gateway = FakeGateway({})
        with self.assertRaisesRegex(ValueError, "已有笔记"):
            refine_knowledge_note(gateway, {"note": {}, "material": {"text": "素材"}})
        with self.assertRaisesRegex(ValueError, "不能为空"):
            refine_knowledge_note(gateway, {"note": {"title": "A", "content": "B"}, "material": {}})

    def test_generates_cards_from_one_selected_note_without_rewriting_it(self):
        gateway = FakeGateway({"review_cards": [
            {"question": "反馈延迟会造成什么判断偏差？", "answer": "短期观察可能看不到行动带来的后果。"},
            {"question": "如何降低这种偏差？", "answer": "同时记录行动与反馈发生的时间尺度。"},
        ]})
        result = generate_knowledge_cards(gateway, {
            "note": {"title": "系统思考", "content": "反馈延迟会掩盖因果。"},
        })
        self.assertEqual(len(result["review_cards"]), 2)
        self.assertIn("只根据", gateway.calls[0][0])
        self.assertNotIn("merged_note", result)


if __name__ == "__main__":
    unittest.main()
