import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  declareArtifactWatchPaths,
  subscribeArtifactWatch,
  closeAllArtifactWatchers,
  _activeWatcherCount,
  type ArtifactWatchEvent,
} from "../src/services/artifactWatcher";

// Short debounce so tests aren't slow; still non-zero to exercise merging.
process.env.ARTIFACT_WATCH_DEBOUNCE_MS = "40";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "artwatch-"));
  tmpDirs.push(d);
  return d;
}

/** Poll until `predicate()` is true or `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("artifactWatcher", () => {
  beforeEach(() => closeAllArtifactWatchers());
  afterEach(() => {
    closeAllArtifactWatchers();
    for (const d of tmpDirs.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test("stat-confirm swallows a no-op touch (unchanged mtime/size)", async () => {
    const cwd = mkTmp();
    const file = path.join(cwd, "note.md");
    fs.writeFileSync(file, "abc");
    // Pin a whole-second mtime so it round-trips through the filesystem exactly
    // (Date has ms precision; a whole-second value has no sub-ms tail to lose).
    const pinned = new Date(1_600_000_000_000);
    fs.utimesSync(file, pinned, pinned);

    const events: ArtifactWatchEvent[] = [];
    subscribeArtifactWatch(cwd, (e) => events.push(e));
    declareArtifactWatchPaths(cwd, ["note.md"]); // seeds last-known = pinned/size

    // Re-set the identical mtime → fires an fs event but stat is unchanged.
    fs.utimesSync(file, pinned, pinned);
    await sleep(300);
    assert.equal(events.length, 0, "a stat-identical touch must be swallowed");

    // Positive control: a genuine content change still emits — proving the
    // watcher is live, not merely silent.
    fs.writeFileSync(file, "abcd");
    await waitFor(() => events.length >= 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].removed, false);
  });

  test("deletion emits a removed event", async () => {
    const cwd = mkTmp();
    const file = path.join(cwd, "gone.md");
    fs.writeFileSync(file, "here");
    const events: ArtifactWatchEvent[] = [];
    subscribeArtifactWatch(cwd, (e) => events.push(e));
    declareArtifactWatchPaths(cwd, ["gone.md"]);

    // macOS may attach the directory watcher after fs.watch returns. Confirm
    // that it observes a real change before testing a one-shot deletion.
    const deadline = Date.now() + 3000;
    while (events.length === 0 && Date.now() < deadline) {
      fs.appendFileSync(file, ".");
      await sleep(100);
    }
    assert.ok(events.some((e) => !e.removed), "watcher must be live before deletion");
    events.length = 0;

    fs.rmSync(file);
    await waitFor(() => events.some((e) => e.removed === true));
    const removed = events.find((e) => e.removed === true);
    assert.ok(removed, "expected a removed event");
    assert.equal(removed!.filePath, "gone.md");
  });

  test("sandbox rejects paths escaping the cwd", () => {
    const cwd = mkTmp();
    const { watching, rejected } = declareArtifactWatchPaths(cwd, [
      "../escape.md",
      "/etc/passwd",
      "ok.md",
    ]);
    assert.deepEqual(watching, ["ok.md"]);
    assert.ok(rejected.includes("../escape.md"));
    assert.ok(rejected.includes("/etc/passwd"));
  });

  test("refcount lifecycle: last unsubscribe drops the watcher entry", async () => {
    const cwd = mkTmp();
    fs.writeFileSync(path.join(cwd, "x.md"), "1");
    const unsub1 = subscribeArtifactWatch(cwd, () => {});
    const unsub2 = subscribeArtifactWatch(cwd, () => {});
    declareArtifactWatchPaths(cwd, ["x.md"]);
    assert.equal(_activeWatcherCount(), 1);

    unsub1();
    assert.equal(_activeWatcherCount(), 1, "still one subscriber → entry stays");
    unsub2();
    assert.equal(_activeWatcherCount(), 0, "no subscribers, no regs → entry dropped");
  });
});
