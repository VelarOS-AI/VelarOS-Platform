"""用途：验证原生准备保留成功与失败回执，并在超时后收回所拥有的构建进程。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

from prepare import prepare_workspace


class NativePreparationTests(unittest.TestCase):
    def test_recipe_and_failed_step_are_recorded_without_shell_interpretation(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            profile = {"python": sys.executable, "prepare_environment": {"TASK_RECEIPT": "literal $(false)"}, "prepare_commands": [["{python}", "-c", "import os;from pathlib import Path;Path('value').write_text(os.environ['TASK_RECEIPT'])"], ["{python}", "-c", "raise SystemExit(3)"]]}
            with self.assertRaisesRegex(ValueError, "preparation failed"):
                prepare_workspace(profile, root, root / "receipts")
            self.assertEqual((root / "value").read_text(), "literal $(false)")
            rows = json.loads((root / "receipts/receipts.json").read_text())
            self.assertEqual([row["exitCode"] for row in rows], [0, 3])
            self.assertTrue(all(row["finishedAt"] >= row["startedAt"] for row in rows))

    def test_timeout_keeps_a_failure_receipt(self):
        with tempfile.TemporaryDirectory() as value:
            root = Path(value)
            profile = {"python": sys.executable, "prepare_timeout_seconds": 0.05, "prepare_commands": [["{python}", "-c", "import time;time.sleep(60)"]]}
            with self.assertRaisesRegex(ValueError, "deadline exceeded"):
                prepare_workspace(profile, root, root / "receipts")
            rows = json.loads((root / "receipts/receipts.json").read_text())
            self.assertTrue(rows[0]["timedOut"])
            self.assertIn("finishedAt", rows[0])


if __name__ == "__main__":
    unittest.main()
