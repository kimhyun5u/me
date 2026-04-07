const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const TOOLBOX_SHORTCUTS = ["open", "done", "queued", "running", "succeeded", "failed"];

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

function fakeCodexProfileConfig(profile) {
  switch (profile) {
    case "ready":
      return {
        steps: [
          { delayMs: 0, type: "message", text: "Emulator connected" },
          { delayMs: 500, type: "message", text: "Emulator completed" },
        ],
        output: "Emulator completed",
        exitCode: 0,
      };
    case "slow":
      return {
        steps: [
          { delayMs: 0, type: "thread", threadId: "emulator-thread" },
          { delayMs: 300, type: "message", text: "Analyzing task" },
          { delayMs: 700, type: "message", text: "Applying mock changes" },
          { delayMs: 1100, type: "message", text: "Finishing verification" },
        ],
        output: "Slow emulator flow completed",
        exitCode: 0,
      };
    case "fail":
      return {
        steps: [
          { delayMs: 0, type: "message", text: "Starting emulator failure path" },
          { delayMs: 500, type: "stderr", text: "Mock Codex failure" },
        ],
        output: null,
        exitCode: 1,
      };
    default:
      throw new Error(`Unknown fake Codex profile: ${profile}`);
  }
}

async function createFakeCodexBinary(baseDir, profile = "ready") {
  const scriptPath = path.join(baseDir, `fake-codex-${profile}.js`);
  const config = fakeCodexProfileConfig(profile);
  const scriptBody = `#!/usr/bin/env node
const fs = require("node:fs/promises");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    process.stdout.write("fake-codex ${profile}\\\\n");
    return;
  }

  const outputIndex = args.indexOf("-o");
  const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;
  const steps = ${JSON.stringify(config.steps)};

  const startedAt = Date.now();

  for (const step of steps) {
    const waitMs = Math.max(0, step.delayMs - (Date.now() - startedAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    if (step.type === "thread") {
      process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: step.threadId }) + "\\\\n");
      continue;
    }

    if (step.type === "message") {
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: step.text },
      }) + "\\\\n");
      continue;
    }

    if (step.type === "stderr") {
      process.stderr.write(step.text + "\\\\n");
    }
  }

  if (outputFile && ${JSON.stringify(config.output)} !== null) {
    await fs.writeFile(outputFile, ${JSON.stringify(config.output)}, "utf8");
  }

  process.exitCode = ${config.exitCode};
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\\\\n");
  process.exitCode = 1;
});
`;

  await fs.writeFile(scriptPath, scriptBody, "utf8");
  await fs.chmod(scriptPath, 0o755);

  return scriptPath;
}

function buildSandboxEnv({ homeDir, dataDir }) {
  return {
    ...process.env,
    ME_HOME_DIR: homeDir,
    ME_DATA_DIR: dataDir,
    ME_DISABLE_SYSTEM_CODEX_CANDIDATES: "1",
    CODEX_BIN: "",
  };
}

async function prepareSandbox(prefix = "me-emulator-") {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(sandboxRoot, "home");
  const dataDir = path.join(sandboxRoot, "data");
  const meRoot = path.join(homeDir, ".me");

  await Promise.all([ensureDirectory(homeDir), ensureDirectory(dataDir), ensureDirectory(meRoot)]);

  return {
    sandboxRoot,
    homeDir,
    dataDir,
    meRoot,
    env: buildSandboxEnv({ homeDir, dataDir }),
  };
}

async function prepareCodexScenario(scenario) {
  const sandbox = await prepareSandbox("me-scenario-");

  switch (scenario) {
    case "codex-missing":
      break;
    case "codex-broken-config":
      await fs.writeFile(
        path.join(sandbox.meRoot, "config.json"),
        JSON.stringify({ codexBin: path.join(sandbox.sandboxRoot, "missing-codex") }, null, 2),
        "utf8",
      );
      break;
    case "codex-fake":
      sandbox.env.CODEX_BIN = await createFakeCodexBinary(sandbox.sandboxRoot, "ready");
      break;
    default:
      throw new Error(
        `Unknown scenario: ${scenario}. Use codex-missing, codex-broken-config, or codex-fake.`,
      );
  }

  return sandbox;
}

function isoDateWithOffset(offsetMinutes) {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

function buildTask({
  title,
  completed = false,
  createdAt,
  codexStatus = "idle",
  lastOutput = null,
  lastError = null,
  log = null,
}) {
  return {
    id: crypto.randomUUID(),
    title,
    completed,
    created_at: createdAt,
    import_type: "quick-add",
    codex_status: codexStatus,
    codex_last_run_at: codexStatus === "idle" ? null : createdAt,
    codex_last_output: lastOutput,
    codex_last_error: lastError,
    codex_log: log,
    codex_workspace: null,
    codex_workspace_source: null,
    codex_runner_pid: null,
  };
}

function shortcutDefaults(shortcut) {
  switch (shortcut) {
    case "open":
      return {
        title: "Emulator open task",
        completed: false,
        codexStatus: "idle",
        lastOutput: null,
        lastError: null,
        log: null,
      };
    case "done":
      return {
        title: "Emulator completed task",
        completed: true,
        codexStatus: "idle",
        lastOutput: null,
        lastError: null,
        log: null,
      };
    case "queued":
      return {
        title: "Emulator queued task",
        completed: false,
        codexStatus: "queued",
        lastOutput: null,
        lastError: null,
        log: "[message] Waiting in emulator queue\n",
      };
    case "running":
      return {
        title: "Emulator running task",
        completed: false,
        codexStatus: "running",
        lastOutput: null,
        lastError: null,
        log: "[message] Emulator running step 1\n[message] Emulator running step 2\n",
      };
    case "succeeded":
      return {
        title: "Emulator succeeded task",
        completed: false,
        codexStatus: "succeeded",
        lastOutput: "Emulator success output.",
        lastError: null,
        log: "[message] Emulator finished successfully\n",
      };
    case "failed":
      return {
        title: "Emulator failed task",
        completed: false,
        codexStatus: "failed",
        lastOutput: null,
        lastError: "Emulator failure output.",
        log: "[message] Emulator failed on purpose\n",
      };
    default:
      throw new Error(`Unknown emulator shortcut: ${shortcut}`);
  }
}

function buildShortcutTask({ shortcut, title, runnerPid = null, createdAt = isoDateWithOffset(0) }) {
  const preset = shortcutDefaults(shortcut);

  return {
    ...buildTask({
      title: title?.trim() || preset.title,
      completed: preset.completed,
      createdAt,
      codexStatus: preset.codexStatus,
      lastOutput: preset.lastOutput,
      lastError: preset.lastError,
      log: preset.log,
    }),
    codex_runner_pid:
      preset.codexStatus === "queued" || preset.codexStatus === "running" ? runnerPid : null,
  };
}

function buildSeedTasks(seed = "demo") {
  switch (seed) {
    case "empty":
      return [];
    case "demo":
      return [
        buildTask({
          title: "Try adding a task in emulator mode",
          createdAt: isoDateWithOffset(-1),
        }),
        buildTask({
          title: "Review mock Codex success output",
          createdAt: isoDateWithOffset(-2),
          codexStatus: "succeeded",
          lastOutput: "Mock task completed successfully.",
          log: "[message] Emulator connected\n[message] Emulator completed\n",
        }),
        buildTask({
          title: "Inspect mock Codex failure output",
          createdAt: isoDateWithOffset(-3),
          codexStatus: "failed",
          lastError: "Mock Codex failure.",
          log: "[message] Starting emulator failure path\n",
        }),
      ];
    default:
      throw new Error(`Unknown seed profile: ${seed}`);
  }
}

async function seedTasks(dataDir, seed = "demo") {
  const tasks = buildSeedTasks(seed);
  await ensureDirectory(dataDir);
  await fs.writeFile(
    path.join(dataDir, "tasks.json"),
    JSON.stringify({ tasks }, null, 2),
    "utf8",
  );
}

function parseEmulatorArgs(argv) {
  const options = {
    profile: "slow",
    seed: "demo",
    keepSandbox: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--profile" && argv[index + 1]) {
      options.profile = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--seed" && argv[index + 1]) {
      options.seed = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--keep-sandbox") {
      options.keepSandbox = true;
      continue;
    }
  }

  return options;
}

async function prepareEmulator({ profile = "slow", seed = "demo" } = {}) {
  const sandbox = await prepareSandbox("me-emulator-");
  sandbox.env.ME_EMULATOR = "1";
  sandbox.env.ME_EMULATOR_PROFILE = profile;
  sandbox.env.ME_EMULATOR_SEED = seed;

  if (profile === "missing") {
    sandbox.profileLabel = "missing";
  } else if (profile === "broken-config") {
    await fs.writeFile(
      path.join(sandbox.meRoot, "config.json"),
      JSON.stringify({ codexBin: path.join(sandbox.sandboxRoot, "missing-codex") }, null, 2),
      "utf8",
    );
    sandbox.profileLabel = "broken-config";
  } else {
    sandbox.env.CODEX_BIN = await createFakeCodexBinary(sandbox.sandboxRoot, profile);
    sandbox.profileLabel = profile;
  }

  await seedTasks(sandbox.dataDir, seed);

  return {
    ...sandbox,
    seed,
  };
}

module.exports = {
  TOOLBOX_SHORTCUTS,
  buildSeedTasks,
  buildShortcutTask,
  createFakeCodexBinary,
  ensureDirectory,
  npmCommand,
  parseEmulatorArgs,
  prepareCodexScenario,
  prepareEmulator,
  prepareSandbox,
  seedTasks,
};
