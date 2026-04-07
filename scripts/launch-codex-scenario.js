const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function createFakeCodexBinary(baseDir) {
  const scriptPath = path.join(baseDir, "fake-codex.js");
  const scriptBody = `#!/usr/bin/env node
const fs = require("node:fs/promises");

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    process.stdout.write("fake-codex 1.0\\n");
    return;
  }

  const outputIndex = args.indexOf("-o");
  const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : null;

  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Scenario runner connected" },
  }) + "\\n");

  await new Promise((resolve) => setTimeout(resolve, 600));

  if (outputFile) {
    await fs.writeFile(outputFile, "Scenario completed", "utf8");
  }

  process.stdout.write(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Scenario completed" },
  }) + "\\n");
}

main().catch((error) => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\\n");
  process.exitCode = 1;
});
`;

  await fs.writeFile(scriptPath, scriptBody, "utf8");
  await fs.chmod(scriptPath, 0o755);

  return scriptPath;
}

async function prepareScenario(scenario) {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "me-scenario-"));
  const homeDir = path.join(sandboxRoot, "home");
  const meRoot = path.join(homeDir, ".me");
  const env = {
    ...process.env,
    ME_HOME_DIR: homeDir,
    ME_DISABLE_SYSTEM_CODEX_CANDIDATES: "1",
    CODEX_BIN: "",
  };

  await ensureDirectory(meRoot);

  switch (scenario) {
    case "codex-missing":
      break;
    case "codex-broken-config":
      await fs.writeFile(
        path.join(meRoot, "config.json"),
        JSON.stringify({ codexBin: path.join(sandboxRoot, "missing-codex") }, null, 2),
        "utf8",
      );
      break;
    case "codex-fake": {
      const fakeCodex = await createFakeCodexBinary(sandboxRoot);
      env.CODEX_BIN = fakeCodex;
      break;
    }
    default:
      throw new Error(
        `Unknown scenario: ${scenario}. Use codex-missing, codex-broken-config, or codex-fake.`,
      );
  }

  return {
    env,
    homeDir,
    sandboxRoot,
  };
}

async function main() {
  const scenario = process.argv[2];

  if (!scenario) {
    throw new Error("Missing scenario name.");
  }

  const prepared = await prepareScenario(scenario);
  process.stdout.write(
    [
      `Scenario: ${scenario}`,
      `Sandbox root: ${prepared.sandboxRoot}`,
      `Home override: ${prepared.homeDir}`,
      "Close the app window or press Ctrl+C to end the scenario.",
      "",
    ].join("\n"),
  );

  const child = spawn(npmCommand(), ["run", "dev"], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
    env: prepared.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
