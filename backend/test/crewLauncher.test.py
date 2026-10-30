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
REPO_ROOT = Path(__file__).resolve().parents[2]


def write_minimum(root, value=">=22.19.0"):
    (root / "package.json").write_text(json.dumps({"name": "fixture", "engines": {"node": value}}))


class LauncherTests(unittest.TestCase):
    def test_version_requirement(self):
        for value in ["v22.19.0", "24.0.0", "v23.1.0"]:
            self.assertTrue(launcher.supported_node_version(value, (22, 19, 0)))
        for value in ["v18.20.0", "v22.18.9", "unknown", "22.19"]:
            self.assertFalse(launcher.supported_node_version(value, (22, 19, 0)))

    def test_minimum_comes_from_the_installation_package_json(self):
        root_engines = json.loads((REPO_ROOT / "package.json").read_text())["engines"]["node"]
        self.assertEqual(">=" + ".".join(map(str, launcher.minimum_node_version(REPO_ROOT))), root_engines)
        with tempfile.TemporaryDirectory(prefix="michi launcher minimum ") as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                launcher.minimum_node_version(root)
            write_minimum(root, ">=23.4.5")
            self.assertEqual(launcher.minimum_node_version(root), (23, 4, 5))
            write_minimum(root, ">=22")
            with self.assertRaisesRegex(RuntimeError, "engines.node"):
                launcher.minimum_node_version(root)

    def test_pinned_build_node_wins_and_old_node_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="michi launcher with spaces ") as tmp:
            root = Path(tmp)
            write_minimum(root)
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

    def test_install_root_is_the_installation_the_manifest_started(self):
        # The manifest picks <root>/crew-app/launch.py from MICHI_CREW_INSTALL_DIR
        # or ~/.michi; the launcher must use that same root, not resolve it again.
        with tempfile.TemporaryDirectory(prefix="michi launcher root ") as tmp:
            root = Path(tmp).resolve()
            (root / "crew-app").mkdir()
            copy = root / "crew-app/launch.py"
            copy.write_text(Path(launcher.__file__).read_text())
            copy_spec = importlib.util.spec_from_file_location("crew_launcher_copy", copy)
            module = importlib.util.module_from_spec(copy_spec)
            copy_spec.loader.exec_module(module)
            with patch.dict(module.os.environ, {"MICHI_CREW_INSTALL_DIR": str(root / "elsewhere"), "HOME": str(root / "home")}):
                self.assertEqual(module.install_root(), root)

    def test_explicit_override_is_not_silently_replaced(self):
        self.assertEqual(launcher.node_candidates(Path("/unused"), {"MICHI_CREW_NODE": "/missing/node"}), ["/missing/node"])
        with tempfile.TemporaryDirectory(prefix="michi launcher override ") as tmp:
            write_minimum(Path(tmp))
            with self.assertRaisesRegex(RuntimeError, "Node.js"):
                launcher.resolve_node(Path(tmp), {"MICHI_CREW_NODE": "/missing/node"})


if __name__ == "__main__":
    unittest.main()
