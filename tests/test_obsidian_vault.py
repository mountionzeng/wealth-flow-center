import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from core.obsidian_vault import ObsidianVaultBridge, ObsidianVaultError


class ObsidianVaultBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.vault = self.root / "测试知识库"
        (self.vault / "课程").mkdir(parents=True)
        (self.vault / ".obsidian").mkdir()
        (self.vault / "课程" / "第一课.md").write_text("# 第一课\n\n原始内容。\n", encoding="utf-8")
        (self.vault / ".obsidian" / "workspace.md").write_text("不应出现", encoding="utf-8")
        (self.vault / "附件.txt").write_text("不应出现", encoding="utf-8")
        self.other = self.root / "旧知识库"
        self.other.mkdir()
        self.config = self.root / "obsidian.json"
        self.config.write_text(json.dumps({
            "vaults": {
                "active-id": {"path": str(self.vault), "open": True},
                "old-id": {"path": str(self.other), "open": False},
            },
        }), encoding="utf-8")
        self.bridge = ObsidianVaultBridge(self.config)

    def tearDown(self):
        self.temporary.cleanup()

    def test_lists_active_vault_first_and_filters_tree(self):
        result = self.bridge.list_vaults()
        self.assertEqual(result["active_vault_id"], "active-id")
        self.assertEqual([vault["name"] for vault in result["vaults"]], ["测试知识库", "旧知识库"])
        self.assertNotIn("path", result["vaults"][0])

        tree = self.bridge.tree("active-id")
        self.assertEqual([item["path"] for item in tree["files"]], ["课程/第一课.md"])
        self.assertEqual(tree["files"][0]["directory"], "课程")
        self.assertIn("obsidian://open?vault=", tree["files"][0]["obsidian_url"])
        self.assertNotIn("path", tree["vault"])

    def test_reads_and_atomically_writes_utf8_markdown(self):
        original = self.bridge.read("active-id", "课程/第一课.md")
        self.assertEqual(original["content"], "# 第一课\n\n原始内容。\n")

        saved = self.bridge.write(
            "active-id",
            "课程/第一课.md",
            "# 第一课\n\n网页保存的内容。\n",
            original["content_hash"],
        )
        self.assertEqual(saved["content"], "# 第一课\n\n网页保存的内容。\n")
        self.assertNotEqual(saved["content_hash"], original["content_hash"])
        self.assertEqual((self.vault / "课程" / "第一课.md").read_text(encoding="utf-8"), saved["content"])

    def test_rejects_stale_write_without_overwriting_external_change(self):
        original = self.bridge.read("active-id", "课程/第一课.md")
        note = self.vault / "课程" / "第一课.md"
        note.write_text("Obsidian 刚刚改过。", encoding="utf-8")

        with self.assertRaisesRegex(ObsidianVaultError, "刚刚在 Obsidian") as raised:
            self.bridge.write("active-id", "课程/第一课.md", "网页中的旧草稿", original["content_hash"])

        self.assertEqual(raised.exception.code, "obsidian_conflict")
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(note.read_text(encoding="utf-8"), "Obsidian 刚刚改过。")

    def test_only_one_concurrent_write_can_use_the_same_expected_hash(self):
        original = self.bridge.read("active-id", "课程/第一课.md")
        barrier = threading.Barrier(3)
        results = []

        def save(content):
            barrier.wait()
            try:
                self.bridge.write("active-id", "课程/第一课.md", content, original["content_hash"])
                results.append("saved")
            except ObsidianVaultError as exc:
                results.append(exc.code)

        workers = [threading.Thread(target=save, args=(f"网页保存 {index}",)) for index in range(2)]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join()

        self.assertCountEqual(results, ["saved", "obsidian_conflict"])

    def test_rechecks_external_change_before_atomic_replace(self):
        original = self.bridge.read("active-id", "课程/第一课.md")
        note = self.vault / "课程" / "第一课.md"
        real_fsync = os.fsync

        def modify_after_fsync(descriptor):
            real_fsync(descriptor)
            note.write_text("Obsidian 在保存窗口内改过。", encoding="utf-8")

        with patch("core.obsidian_vault.os.fsync", side_effect=modify_after_fsync):
            with self.assertRaises(ObsidianVaultError) as raised:
                self.bridge.write("active-id", "课程/第一课.md", "网页草稿", original["content_hash"])

        self.assertEqual(raised.exception.code, "obsidian_conflict")
        self.assertEqual(note.read_text(encoding="utf-8"), "Obsidian 在保存窗口内改过。")
        self.assertEqual(list(note.parent.glob(f".{note.name}.*.tmp")), [])

    def test_rejects_paths_outside_vault_and_non_markdown_files(self):
        outside = self.root / "outside.md"
        outside.write_text("secret", encoding="utf-8")
        with self.assertRaises(ObsidianVaultError):
            self.bridge.read("active-id", "../outside.md")
        with self.assertRaisesRegex(ObsidianVaultError, "Markdown"):
            self.bridge.read("active-id", "附件.txt")


if __name__ == "__main__":
    unittest.main()
