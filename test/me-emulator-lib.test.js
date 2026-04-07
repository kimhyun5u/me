const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const {
  TOOLBOX_SHORTCUTS,
  buildSeedTasks,
  buildShortcutTask,
  parseEmulatorArgs,
  prepareCodexScenario,
  prepareEmulator,
} = require("../scripts/me-emulator-lib");

test("parseEmulatorArgs returns defaults", () => {
  assert.deepEqual(parseEmulatorArgs([]), {
    profile: "slow",
    seed: "demo",
    keepSandbox: false,
  });
});

test("parseEmulatorArgs reads explicit options", () => {
  assert.deepEqual(
    parseEmulatorArgs(["--profile", "fail", "--seed", "empty", "--keep-sandbox"]),
    {
      profile: "fail",
      seed: "empty",
      keepSandbox: true,
    },
  );
});

test("buildSeedTasks returns demo fixtures", () => {
  const tasks = buildSeedTasks("demo");

  assert.equal(tasks.length, 3);
  assert.equal(tasks[0].codex_status, "idle");
  assert.equal(tasks[1].codex_status, "succeeded");
  assert.equal(tasks[2].codex_status, "failed");
});

test("buildShortcutTask creates running task with runner pid", () => {
  const task = buildShortcutTask({
    shortcut: "running",
    title: "Shortcut task",
    runnerPid: 999,
  });

  assert.equal(task.title, "Shortcut task");
  assert.equal(task.codex_status, "running");
  assert.equal(task.codex_runner_pid, 999);
  assert.match(task.codex_log, /running step/i);
});

test("toolbox shortcut list is stable", () => {
  assert.deepEqual(TOOLBOX_SHORTCUTS, [
    "open",
    "done",
    "queued",
    "running",
    "succeeded",
    "failed",
  ]);
});

test("prepareCodexScenario isolates home and data paths", async () => {
  const prepared = await prepareCodexScenario("codex-missing");

  assert.match(prepared.homeDir, /me-scenario-/);
  assert.match(prepared.dataDir, /me-scenario-/);
  assert.equal(prepared.env.ME_HOME_DIR, prepared.homeDir);
  assert.equal(prepared.env.ME_DATA_DIR, prepared.dataDir);
  assert.equal(prepared.env.ME_DISABLE_SYSTEM_CODEX_CANDIDATES, "1");

  await fs.rm(prepared.sandboxRoot, { recursive: true, force: true });
});

test("prepareEmulator seeds demo tasks and fake codex profile", async () => {
  const prepared = await prepareEmulator({
    profile: "ready",
    seed: "demo",
  });
  const tasksRaw = await fs.readFile(path.join(prepared.dataDir, "tasks.json"), "utf8");
  const tasks = JSON.parse(tasksRaw).tasks;

  assert.equal(prepared.profileLabel, "ready");
  assert.ok(prepared.env.CODEX_BIN);
  assert.equal(tasks.length, 3);

  await fs.rm(prepared.sandboxRoot, { recursive: true, force: true });
});
