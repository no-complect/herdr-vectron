import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

ENTRY = Path(__file__).resolve().parents[1] / "vectron-tabs" / "reopen.py"
SPEC = importlib.util.spec_from_file_location("reopen", ENTRY)
reopen = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reopen)


class TabReopenTests(unittest.TestCase):
    def test_rebuilt_splits_use_new_terminals_without_mutating_saved_geometry(self):
        original = {
            "id": "old-tab",
            "type": "row",
            "children": [
                {"id": "left", "content": {"terminal": "old-left"}, "size": {"weight": 2}},
                {"id": "right", "content": {"terminal": "old-right"}},
            ],
        }
        replacement = reopen.restore_tree(
            original, {"old-left": "new-left", "old-right": "new-right"}, "new-tab"
        )

        self.assertEqual(replacement["id"], "new-tab")
        self.assertEqual(replacement["type"], "row")
        self.assertEqual(replacement["children"][0]["size"], {"weight": 2})
        self.assertEqual(
            [n["content"]["terminal"] for n in replacement["children"]],
            ["new-left", "new-right"],
        )
        self.assertEqual(original["children"][0]["content"]["terminal"], "old-left")
        self.assertNotEqual(replacement["children"][0]["id"], "left")

    def test_session_matching_prefers_nearest_unused_launch_in_same_folder(self):
        proc = {"cwd": "/project", "started": 100}
        sessions = [
            {"cwd": "/other", "created": 100, "id": "wrong-folder"},
            {"cwd": "/project", "created": 350, "id": "too-late"},
            {"cwd": "/project", "created": 101, "id": "taken"},
            {"cwd": "/project", "created": 110, "id": "match"},
        ]
        self.assertEqual(reopen.match_session(proc, sessions, {"taken"})["id"], "match")
        self.assertIsNone(reopen.match_session(proc, sessions, {"taken", "match"}))

    def test_geometry_is_available_when_process_tracking_is_unavailable(self):
        document = {"spaces": [{"id": "fixture"}]}
        with patch.object(reopen, "Core") as core:
            core.return_value.call.return_value = {"value": document}
            with patch.object(
                reopen, "scan_processes", return_value={"shell": "/bin/sh", "procs": {}}
            ):
                result = reopen.scan()

        self.assertEqual(result, {"shell": "/bin/sh", "procs": {}, "document": document})
        core.return_value.call.assert_called_once_with("doc.get", name="herdr-app")
        core.return_value.close.assert_called_once()
