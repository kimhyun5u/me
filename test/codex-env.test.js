const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildCodexInfo,
  defaultCodexWorkspaceRoot,
  ensurePersonalizationFiles,
  writeAppConfig,
} = require("../electron/codex-env");

async function makeTempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "me-codex-env-"));
}

async function makeFakeCodexBinary(dirPath) {
  const scriptPath = path.join(dirPath, "fake-codex.js");
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0\\n");
  process.exit(0);
}
process.stdout.write("ok\\n");
`,
    "utf8",
  );
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

test("defaultCodexWorkspaceRoot respects ME_HOME_DIR", () => {
  const root = defaultCodexWorkspaceRoot({
    env: {
      ...process.env,
      ME_HOME_DIR: "/tmp/me-home",
    },
  });

  assert.equal(root, path.join("/tmp/me-home", ".me"));
});

test("ensurePersonalizationFiles creates starter files in isolated home", async () => {
  const homeDir = await makeTempHome();
  const env = {
    ...process.env,
    ME_HOME_DIR: homeDir,
    ME_DISABLE_SYSTEM_CODEX_CANDIDATES: "1",
    CODEX_BIN: "",
  };

  const files = await ensurePersonalizationFiles({ env });
  const agents = await fs.readFile(files.agentsPath, "utf8");
  const profile = await fs.readFile(files.profilePath, "utf8");

  assert.equal(files.root, path.join(homeDir, ".me"));
  assert.match(agents, /Personal Me Instructions/);
  assert.match(profile, /Personal Profile/);

  await fs.rm(homeDir, { recursive: true, force: true });
});

test("buildCodexInfo reports missing Codex when no command is configured", async () => {
  const homeDir = await makeTempHome();
  const env = {
    ...process.env,
    ME_HOME_DIR: homeDir,
    ME_DISABLE_SYSTEM_CODEX_CANDIDATES: "1",
    CODEX_BIN: "",
  };

  const info = await buildCodexInfo({ env });

  assert.equal(info.available, false);
  assert.equal(info.command, null);
  assert.equal(info.configuredCommand, null);

  await fs.rm(homeDir, { recursive: true, force: true });
});

test("buildCodexInfo keeps broken configured path but stays unavailable", async () => {
  const homeDir = await makeTempHome();
  const env = {
    ...process.env,
    ME_HOME_DIR: homeDir,
    ME_DISABLE_SYSTEM_CODEX_CANDIDATES: "1",
    CODEX_BIN: "",
  };
  const brokenPath = path.join(homeDir, "missing-codex");

  await writeAppConfig({ codexBin: brokenPath }, { env });
  const info = await buildCodexInfo({ env });

  assert.equal(info.available, false);
  assert.equal(info.command, null);
  assert.equal(info.configuredCommand, brokenPath);

  await fs.rm(homeDir, { recursive: true, force: true });
});

test("buildCodexInfo reports available when a fake Codex binary is provided", async () => {
  const homeDir = await makeTempHome();
  const fakeCodex = await makeFakeCodexBinary(homeDir);
  const env = {
    ...process.env,
    ME_HOME_DIR: homeDir,
    ME_DISABLE_SYSTEM_CODEX_CANDIDATES: "1",
    CODEX_BIN: fakeCodex,
  };

  const info = await buildCodexInfo({ env });

  assert.equal(info.available, true);
  assert.equal(info.command, fakeCodex);
  assert.equal(info.defaultWorkspace, path.join(homeDir, ".me"));

  await fs.rm(homeDir, { recursive: true, force: true });
});
