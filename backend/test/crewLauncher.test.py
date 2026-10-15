"""Launcher behavior; no user config, packages or Gateway are modified."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("crew_launcher", Path(__file__).resolve().parents[2] / "crew-app/launch.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def test_version_requirement(self):
        for value in ["v22.19.0", "24.0.0", "v23.1.0"]:
            self.assertTrue(launcher.supported_node_version(value))
        for value in ["v18.20.0", "v22.18.9", "unknown", "22.19"]:
            self.assertFalse(launcher.supported_node_version(value))

    def test_pinned_build_node_wins_and_old_node_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="michi launcher with spaces ") as tmp:
            root = Path(tmp)
            pinned = root / "new-node"
            old = root / "old-node"
            pinned.touch()
            old.touch()
            versions = {str(pinned): "v24.1.0", str(old): "v18.20.0"}
            def probe(args, **_kwargs):
                return subprocess.CompletedProcess(args, 0, versions[args[0]], "")
            with patch.object(launcher, "node_candidates", return_value=[str(old), str(pinned)]), patch.object(launcher.subprocess, "run", side_effect=probe):
                self.assertEqual(launcher.resolve_node(root, {}), str(pinned))
            with patch.object(launcher, "node_candidates", return_value=[str(old)]), patch.object(launcher.subprocess, "run", side_effect=probe):
                with self.assertRaisesRegex(RuntimeError, "22.19"):
                    launcher.resolve_node(root, {})
            (root / "backend/dist").mkdir(parents=True)
            (root / "backend/dist/crew-node.json").write_text(json.dumps({"schemaVersion": 1, "node": str(pinned)}))
            self.assertEqual(launcher.node_candidates(root, {})[0], str(pinned))

    def test_explicit_override_is_not_silently_replaced(self):
        self.assertEqual(launcher.node_candidates(Path("/unused"), {"MICHI_CREW_NODE": "/missing/node"}), ["/missing/node"])
        with self.assertRaisesRegex(RuntimeError, "Node.js"):
            launcher.resolve_node(Path("/unused"), {"MICHI_CREW_NODE": "/missing/node"})


if __name__ == "__main__":
    unittest.main()
