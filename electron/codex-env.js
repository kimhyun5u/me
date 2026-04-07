const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const PERSONAL_AGENTS_FILE = "AGENTS.md";
const PERSONAL_PROFILE_FILE = "profile.md";
const APP_CONFIG_FILE = "config.json";
const DEFAULT_CODEX_BINARY_CANDIDATES = [
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
  "HOME_LOCAL",
  "HOME_BIN",
  "codex",
];

function resolveHomeDir({ app = null, env = process.env, osModule = os } = {}) {
  if (env.ME_HOME_DIR) {
    return env.ME_HOME_DIR;
  }

  try {
    if (app?.getPath) {
      return app.getPath("home");
    }
  } catch {
    // Fall through to os.homedir().
  }

  return osModule.homedir();
}

function defaultCodexWorkspaceRoot(options = {}) {
  return path.join(resolveHomeDir(options), ".me");
}

function personalAgentsPath(options = {}) {
  return path.join(defaultCodexWorkspaceRoot(options), PERSONAL_AGENTS_FILE);
}

function personalProfilePath(options = {}) {
  return path.join(defaultCodexWorkspaceRoot(options), PERSONAL_PROFILE_FILE);
}

function appConfigPath(options = {}) {
  return path.join(defaultCodexWorkspaceRoot(options), APP_CONFIG_FILE);
}

function defaultAppConfig() {
  return {
    codexBin: null,
  };
}

function defaultPersonalAgentsTemplate() {
  return `# Personal Me Instructions

This directory stores local personal guidance for the Me desktop app.

## How Codex Should Use This

- Read \`profile.md\` for personal background and working preferences.
- Personalize planning, wording, and execution using that information.
- Prefer the user's stated defaults when the task is ambiguous.
- Keep this directory for Me app data and personal context only.
- Do not create project files in this directory unless the task is explicitly about \`~/.me\`.

## Notes

- Update this file when there are stable personal rules that should apply to most tasks.
- Keep secrets out of project repositories. Local-only notes belong here.
`;
}

function defaultPersonalProfileTemplate() {
  return `# Personal Profile

Fill in the sections below so Me can personalize task handling.

## Identity

- Name:
- Role:
- Team or Organization:

## Working Preferences

- Preferred language:
- Preferred response style:
- Preferred planning style:
- Default definition of done:

## Project Context

- Main repositories:
- Typical task types:
- Preferred tools:

## Constraints

- Things to avoid:
- Approval or review preferences:
- Testing expectations:
`;
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function ensureFile(filePath, body) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, body, "utf8");
  }
}

async function ensurePersonalizationFiles(options = {}) {
  const root = await ensureDirectory(defaultCodexWorkspaceRoot(options));
  const agentsPath = personalAgentsPath(options);
  const profilePath = personalProfilePath(options);

  await ensureFile(agentsPath, defaultPersonalAgentsTemplate());
  await ensureFile(profilePath, defaultPersonalProfileTemplate());

  return {
    root,
    agentsPath,
    profilePath,
  };
}

async function readAppConfig(options = {}) {
  try {
    const raw = await fs.readFile(appConfigPath(options), "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultAppConfig(),
      ...parsed,
    };
  } catch {
    return defaultAppConfig();
  }
}

async function writeAppConfig(config, options = {}) {
  await ensureDirectory(defaultCodexWorkspaceRoot(options));
  await fs.writeFile(
    appConfigPath(options),
    JSON.stringify(
      {
        ...defaultAppConfig(),
        ...config,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function buildCodexBinaryCandidates({ env = process.env, homeDir } = {}) {
  const defaults =
    env.ME_DISABLE_SYSTEM_CODEX_CANDIDATES === "1"
      ? []
      : DEFAULT_CODEX_BINARY_CANDIDATES.map((candidate) => {
          if (candidate === "HOME_LOCAL") {
            return path.join(homeDir, ".local", "bin", "codex");
          }

          if (candidate === "HOME_BIN") {
            return path.join(homeDir, "bin", "codex");
          }

          return candidate;
        });

  return [env.CODEX_BIN, ...defaults].filter(Boolean);
}

async function probeCommand(candidate, spawnImpl = spawn) {
  return new Promise((resolve) => {
    const child = spawnImpl(candidate, ["--version"], {
      stdio: "ignore",
    });

    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? candidate : null));
  });
}

async function resolveCodexCommand({
  app = null,
  env = process.env,
  osModule = os,
  spawnImpl = spawn,
} = {}) {
  const homeDir = resolveHomeDir({
    app,
    env,
    osModule,
  });
  const config = await readAppConfig({
    app,
    env,
    osModule,
  });
  const candidates = [
    config.codexBin,
    ...buildCodexBinaryCandidates({
      env,
      homeDir,
    }),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = await probeCommand(candidate, spawnImpl);

    if (resolved) {
      return resolved;
    }
  }

  return null;
}

async function buildCodexInfo({
  app = null,
  env = process.env,
  osModule = os,
  spawnImpl = spawn,
} = {}) {
  const command = await resolveCodexCommand({
    app,
    env,
    osModule,
    spawnImpl,
  });
  const personalization = await ensurePersonalizationFiles({
    app,
    env,
    osModule,
  });
  const config = await readAppConfig({
    app,
    env,
    osModule,
  });

  return {
    available: Boolean(command),
    command,
    configuredCommand: config.codexBin,
    defaultWorkspace: personalization.root,
    personalAgentsPath: personalization.agentsPath,
    personalProfilePath: personalization.profilePath,
    appConfigPath: appConfigPath({
      app,
      env,
      osModule,
    }),
  };
}

module.exports = {
  appConfigPath,
  buildCodexBinaryCandidates,
  buildCodexInfo,
  defaultAppConfig,
  defaultCodexWorkspaceRoot,
  ensureDirectory,
  ensurePersonalizationFiles,
  personalAgentsPath,
  personalProfilePath,
  readAppConfig,
  resolveCodexCommand,
  resolveHomeDir,
  writeAppConfig,
};
