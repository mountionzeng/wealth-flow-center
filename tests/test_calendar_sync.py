import json
import subprocess
import unittest
from datetime import datetime, timedelta

from core.calendar_sync import CalendarBridge, CalendarCommandError, MAX_OUTPUT_BYTES


class FakeRunner:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        value = self.outputs.pop(0)
        if isinstance(value, Exception):
            raise value
        return subprocess.CompletedProcess(command, value[0], value[1], value[2])


class CalendarBridgeTests(unittest.TestCase):
    def test_scripts_are_static_and_dynamic_values_are_argv(self):
        title = '复习 "引号"\n第二行'
        runner = FakeRunner([(0, "OK\tid-1\n", "")])
        bridge = CalendarBridge(runner=runner)
        result = bridge.write_event("plan", title, datetime(2026, 8, 5, 9), datetime(2026, 8, 5, 10), "op-123")
        command = runner.calls[0][0]
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(command[:2], ["osascript", "-e"])
        self.assertNotIn(title, command[2])
        self.assertIn(title, command[4:])

    def test_history_returns_only_minimum_fields_and_bounds_window(self):
        now = datetime(2026, 8, 5, 12)
        payload = [{"calendar_name": "工作", "title": "阅读", "start": "2026-08-04T10:00:00", "end": "2026-08-04T11:00:00", "notes": "secret"}]
        runner = FakeRunner([(0, json.dumps(payload, ensure_ascii=False), "")])
        bridge = CalendarBridge(runner=runner, now=lambda: now)
        result = bridge.history(["工作"], days=30, available_calendars=["工作", "私人"])
        self.assertEqual(result, [{"calendar_name": "工作", "title": "阅读", "start": "2026-08-04T10:00:00", "end": "2026-08-04T11:00:00", "duration_minutes": 60}])
        args = runner.calls[0][0]
        self.assertIn("2026-07-06T12:00:00", args)
        self.assertNotIn("私人", args)

    def test_unselected_calendar_is_rejected(self):
        bridge = CalendarBridge(runner=FakeRunner([]))
        with self.assertRaises(ValueError):
            bridge.history(["私人"], available_calendars=["工作"])

    def test_timeout_is_ambiguous_for_write_but_retryable_for_read(self):
        bridge = CalendarBridge(runner=FakeRunner([subprocess.TimeoutExpired("osascript", 1)]))
        result = bridge.write_event("plan", "阅读", datetime.now(), datetime.now() + timedelta(hours=1), "op-1")
        self.assertEqual(result["status"], "ambiguous")

    def test_reconcile_requires_exactly_one_marker(self):
        bridge = CalendarBridge(runner=FakeRunner([(0, "2\n", "")]))
        self.assertEqual(bridge.reconcile("plan", "op-1")["status"], "ambiguous")

    def test_permission_and_unavailable_are_safe_statuses(self):
        denied = CalendarBridge(runner=FakeRunner([(1, "", "Not authorized to send Apple events")]))
        self.assertEqual(denied.list_calendars()["status"], "permission_denied")
        missing = CalendarBridge(runner=FakeRunner([FileNotFoundError()]))
        self.assertEqual(missing.list_calendars()["status"], "unavailable")

    def test_noisy_and_malformed_outputs_are_rejected(self):
        noisy = CalendarBridge(runner=FakeRunner([(0, "x" * (MAX_OUTPUT_BYTES + 1), "")]))
        self.assertEqual(noisy.list_calendars()["status"], "retryable_failure")
        malformed = CalendarBridge(runner=FakeRunner([(0, "not\ta\tvalid-row", "")]))
        with self.assertRaises(CalendarCommandError):
            malformed.history(["工作"], available_calendars=["工作"])

    def test_history_rejects_missing_fields_invalid_dates_and_mixed_timezones(self):
        fixtures = [
            [{"calendar_name": "工作", "start": "2026-08-04T10:00:00", "end": "2026-08-04T11:00:00"}],
            [{"calendar_name": "工作", "title": "阅读", "start": "not-a-date", "end": "2026-08-04T11:00:00"}],
            [{"calendar_name": "工作", "title": "阅读", "start": "2026-08-04T10:00:00+08:00", "end": "2026-08-04T11:00:00"}],
        ]
        for payload in fixtures:
            with self.subTest(payload=payload):
                bridge = CalendarBridge(runner=FakeRunner([(0, json.dumps(payload), "")]))
                with self.assertRaisesRegex(CalendarCommandError, "Malformed Calendar output") as caught:
                    bridge.history(["工作"], available_calendars=["工作"])
                self.assertEqual(caught.exception.status, "retryable_failure")


if __name__ == "__main__":
    unittest.main()
