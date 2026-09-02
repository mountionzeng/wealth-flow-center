"""Constrained access to Markdown files in locally registered Obsidian vaults."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import quote


DEFAULT_OBSIDIAN_CONFIG = Path.home() / "Library" / "Application Support" / "obsidian" / "obsidian.json"
MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
MAX_VAULT_FILES = 5_000


class ObsidianVaultError(ValueError):
    """A safe, user-facing vault operation failure."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class ObsidianVaultBridge:
    """Read and write only Markdown inside vaults registered by Obsidian."""

    def __init__(self, config_path: Path | None = None) -> None:
        self.config_path = config_path or DEFAULT_OBSIDIAN_CONFIG
        self._write_locks_guard = threading.Lock()
        self._write_locks: dict[str, threading.Lock] = {}

    @staticmethod
    def _public_vault(vault: dict[str, Any]) -> dict[str, Any]:
        return {key: vault[key] for key in ("id", "name", "active")}

    def _write_lock(self, file_path: Path) -> threading.Lock:
        key = str(file_path)
        with self._write_locks_guard:
            return self._write_locks.setdefault(key, threading.Lock())

    def _configured_vaults(self) -> list[dict[str, Any]]:
        try:
            source = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
            return []
        if not isinstance(source, dict):
            return []

        vaults = []
        for vault_id, raw in source.get("vaults", {}).items():
            if not isinstance(raw, dict):
                continue
            raw_path = raw.get("path")
            if not isinstance(raw_path, str) or not raw_path.strip():
                continue
            root = Path(raw_path).expanduser()
            try:
                resolved = root.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if not resolved.is_dir():
                continue
            vaults.append({
                "id": str(vault_id),
                "name": resolved.name,
                "path": str(resolved),
                "active": bool(raw.get("open")),
                "root": resolved,
            })
        return sorted(vaults, key=lambda item: (not item["active"], item["name"].casefold()))

    def list_vaults(self) -> dict[str, Any]:
        vaults = self._configured_vaults()
        public = [self._public_vault(vault) for vault in vaults]
        return {
            "vaults": public,
            "active_vault_id": next((vault["id"] for vault in vaults if vault["active"]), public[0]["id"] if public else ""),
        }

    def _vault(self, vault_id: str) -> dict[str, Any]:
        vault = next((item for item in self._configured_vaults() if item["id"] == str(vault_id)), None)
        if vault is None:
            raise ObsidianVaultError("obsidian_vault_not_found", "找不到这个 Obsidian 知识库", 404)
        return vault

    @staticmethod
    def _safe_markdown_path(root: Path, relative_path: str, *, must_exist: bool = True) -> Path:
        raw = str(relative_path or "").strip().replace("\\", "/")
        if not raw or raw.startswith("/") or "\x00" in raw:
            raise ObsidianVaultError("obsidian_path_invalid", "笔记路径不合法")
        candidate = root.joinpath(*raw.split("/"))
        try:
            resolved = candidate.resolve(strict=must_exist)
        except (FileNotFoundError, OSError, RuntimeError) as exc:
            raise ObsidianVaultError("obsidian_note_not_found", "找不到这篇 Obsidian 笔记", 404) from exc
        try:
            resolved.relative_to(root)
        except ValueError as exc:
            raise ObsidianVaultError("obsidian_path_outside_vault", "不能访问知识库以外的文件", 403) from exc
        if resolved.suffix.lower() != ".md":
            raise ObsidianVaultError("obsidian_not_markdown", "只允许读取和保存 Markdown 笔记")
        return resolved

    @staticmethod
    def _digest(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _obsidian_url(vault_name: str, relative_path: str) -> str:
        path_without_suffix = relative_path[:-3] if relative_path.lower().endswith(".md") else relative_path
        return f"obsidian://open?vault={quote(vault_name, safe='')}&file={quote(path_without_suffix, safe='')}"

    def tree(self, vault_id: str) -> dict[str, Any]:
        vault = self._vault(vault_id)
        root = vault["root"]
        files = []
        truncated = False
        for current, directory_names, file_names in os.walk(root, followlinks=False):
            directory_names[:] = sorted(name for name in directory_names if not name.startswith("."))
            current_path = Path(current)
            for file_name in sorted(file_names):
                if file_name.startswith(".") or not file_name.lower().endswith(".md"):
                    continue
                file_path = current_path / file_name
                try:
                    resolved = file_path.resolve(strict=True)
                    resolved.relative_to(root)
                    stat = resolved.stat()
                except (OSError, RuntimeError, ValueError):
                    continue
                relative = resolved.relative_to(root).as_posix()
                parent = Path(relative).parent.as_posix()
                files.append({
                    "path": relative,
                    "name": resolved.stem,
                    "directory": "" if parent == "." else parent,
                    "size": stat.st_size,
                    "modified_at": stat.st_mtime_ns,
                    "oversized": stat.st_size > MAX_MARKDOWN_BYTES,
                    "obsidian_url": self._obsidian_url(vault["name"], relative),
                })
                if len(files) >= MAX_VAULT_FILES:
                    truncated = True
                    break
            if truncated:
                break
        files.sort(key=lambda item: item["path"].casefold())
        return {
            "vault": self._public_vault(vault),
            "files": files,
            "truncated": truncated,
        }

    def read(self, vault_id: str, relative_path: str) -> dict[str, Any]:
        vault = self._vault(vault_id)
        file_path = self._safe_markdown_path(vault["root"], relative_path)
        try:
            data = file_path.read_bytes()
        except OSError as exc:
            raise ObsidianVaultError("obsidian_read_failed", "无法读取这篇 Obsidian 笔记", 500) from exc
        if len(data) > MAX_MARKDOWN_BYTES:
            raise ObsidianVaultError("obsidian_note_too_large", "这篇笔记超过 2 MB，暂时不能在网页中编辑", 413)
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ObsidianVaultError("obsidian_note_encoding", "这篇笔记不是 UTF-8 编码，暂时不能在网页中编辑", 422) from exc
        stat = file_path.stat()
        normalized_path = file_path.relative_to(vault["root"]).as_posix()
        return {
            "vault_id": vault["id"],
            "vault_name": vault["name"],
            "path": normalized_path,
            "title": file_path.stem,
            "content": content,
            "content_hash": self._digest(data),
            "modified_at": stat.st_mtime_ns,
            "size": len(data),
            "obsidian_url": self._obsidian_url(vault["name"], normalized_path),
        }

    def write(self, vault_id: str, relative_path: str, content: str, expected_hash: str) -> dict[str, Any]:
        if not isinstance(content, str):
            raise ObsidianVaultError("obsidian_content_invalid", "笔记内容必须是文字")
        data = content.encode("utf-8")
        if len(data) > MAX_MARKDOWN_BYTES:
            raise ObsidianVaultError("obsidian_note_too_large", "笔记超过 2 MB，无法保存", 413)
        if not expected_hash:
            raise ObsidianVaultError("obsidian_hash_required", "缺少保存前的版本信息")

        vault = self._vault(vault_id)
        file_path = self._safe_markdown_path(vault["root"], relative_path)
        with self._write_lock(file_path):
            try:
                current = file_path.read_bytes()
                original_stat = file_path.stat()
            except OSError as exc:
                raise ObsidianVaultError("obsidian_read_failed", "保存前无法读取原笔记", 500) from exc
            if self._digest(current) != str(expected_hash):
                raise ObsidianVaultError(
                    "obsidian_conflict",
                    "这篇笔记刚刚在 Obsidian 或其他窗口中改过。网页草稿还在，请重新载入后再合并。",
                    409,
                )

            temporary_name = ""
            try:
                with tempfile.NamedTemporaryFile("wb", dir=file_path.parent, prefix=f".{file_path.name}.", suffix=".tmp", delete=False) as handle:
                    temporary_name = handle.name
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(temporary_name, original_stat.st_mode)

                # Obsidian may save while this request is preparing its temporary file.
                # Re-check both identity and content immediately before the replacement.
                latest = file_path.read_bytes()
                latest_stat = file_path.stat()
                same_file = (latest_stat.st_dev, latest_stat.st_ino) == (original_stat.st_dev, original_stat.st_ino)
                if not same_file or self._digest(latest) != str(expected_hash):
                    raise ObsidianVaultError(
                        "obsidian_conflict",
                        "这篇笔记刚刚在 Obsidian 或其他窗口中改过。网页草稿还在，请重新载入后再合并。",
                        409,
                    )
                os.replace(temporary_name, file_path)
                temporary_name = ""
            except ObsidianVaultError:
                raise
            except OSError as exc:
                raise ObsidianVaultError("obsidian_write_failed", "无法保存这篇 Obsidian 笔记", 500) from exc
            finally:
                if temporary_name:
                    try:
                        Path(temporary_name).unlink(missing_ok=True)
                    except OSError:
                        pass
        return self.read(vault_id, relative_path)
