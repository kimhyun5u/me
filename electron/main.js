const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const codexEnv = require("./codex-env");
const emulatorLib = require("../scripts/me-emulator-lib");

let mainWindow = null;
let backendProcess = null;
const pendingRequests = new Map();
const activeCodexTaskIds = new Set();
let taskMonitorTimer = null;
let lastTasksSignature = "";
const COMMON_WORKSPACE_ROOT_NAMES = ["projects", "workspace", "workspaces", "code", "dev"];
const CODEX_RUNS_DIR = "runs";
const TASK_MONITOR_INTERVAL_MS = 1500;

function backendBinaryName() {
  return process.platform === "win32" ? "task-backend.exe" : "task-backend";
}

function resolveBackendCommand() {
  if (app.isPackaged) {
    return {
      command: path.join(process.resourcesPath, "backend", backendBinaryName()),
      args: [],
    };
  }

  return {
    command: path.join(
      app.getAppPath(),
      "rust-backend",
      "target",
      "debug",
      backendBinaryName(),
    ),
    args: [],
  };
}

function rejectAllPending(message) {
  for (const { reject } of pendingRequests.values()) {
    reject(new Error(message));
  }
  pendingRequests.clear();
}

function defaultCodexWorkspaceRoot() {
  return codexEnv.defaultCodexWorkspaceRoot({
    app,
    env: process.env,
  });
}

async function ensureDirectory(dirPath) {
  return codexEnv.ensureDirectory(dirPath);
}

function personalAgentsPath() {
  return codexEnv.personalAgentsPath({
    app,
    env: process.env,
  });
}

function personalProfilePath() {
  return codexEnv.personalProfilePath({
    app,
    env: process.env,
  });
}

function appConfigPath() {
  return codexEnv.appConfigPath({
    app,
    env: process.env,
  });
}

function codexRunsPath() {
  return path.join(defaultCodexWorkspaceRoot(), CODEX_RUNS_DIR);
}

function codexRunSpecPath(taskId) {
  return path.join(codexRunsPath(), `${taskId}.json`);
}

function defaultAppConfig() {
  return codexEnv.defaultAppConfig();
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

async function ensureFile(filePath, body) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, body, "utf8");
  }
}

async function ensurePersonalizationFiles() {
  return codexEnv.ensurePersonalizationFiles({
    app,
    env: process.env,
  });
}

async function readAppConfig() {
  return codexEnv.readAppConfig({
    app,
    env: process.env,
  });
}

async function writeAppConfig(config) {
  return codexEnv.writeAppConfig(config, {
    app,
    env: process.env,
  });
}

async function isDirectory(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function normalizeWorkspaceText(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function collapseWorkspaceText(value) {
  return normalizeWorkspaceText(value).replace(/\s+/g, "");
}

function workspaceTerms(value) {
  return normalizeWorkspaceText(value).split(/\s+/).filter(Boolean);
}

function workspaceRoots() {
  const roots = new Set();
  const devRoot = path.dirname(process.env.INIT_CWD || process.cwd());

  roots.add(devRoot);

  const home = app.getPath("home");
  for (const name of COMMON_WORKSPACE_ROOT_NAMES) {
    roots.add(path.join(home, name));
  }

  return [...roots];
}

async function discoverWorkspaceCandidates() {
  const seen = new Set();
  const candidates = [];

  for (const root of workspaceRoots()) {
    let entries;

    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === ".me") {
        continue;
      }

      const dir = path.join(root, entry.name);

      if (seen.has(dir)) {
        continue;
      }

      seen.add(dir);
      candidates.push({
        name: entry.name,
        dir,
        root,
      });
    }
  }

  return candidates;
}

function scoreWorkspaceCandidate(title, candidate) {
  const normalizedTitle = normalizeWorkspaceText(title);
  const titleTerms = new Set(workspaceTerms(title));
  const candidateTerms = workspaceTerms(candidate.name);
  const collapsedTitle = collapseWorkspaceText(title);
  const collapsedCandidate = collapseWorkspaceText(candidate.name);
  const strongNameMatch =
    collapsedCandidate.length >= 4 || candidateTerms.length > 1;

  if (!candidateTerms.length || !collapsedCandidate) {
    return 0;
  }

  let score = 0;

  if (strongNameMatch && collapsedTitle.includes(collapsedCandidate)) {
    score += 100 + collapsedCandidate.length;
  }

  const joinedCandidate = candidateTerms.join(" ");
  if (strongNameMatch && joinedCandidate && normalizedTitle.includes(joinedCandidate)) {
    score += 40 + joinedCandidate.length;
  }

  for (const term of candidateTerms) {
    if (titleTerms.has(term)) {
      score += Math.max(3, term.length);
      continue;
    }

    for (const titleTerm of titleTerms) {
      if (term.length >= 4 && (titleTerm.startsWith(term) || term.startsWith(titleTerm))) {
        score += 2;
        break;
      }
    }
  }

  return score;
}

async function findMatchedWorkspace(title) {
  const candidates = await discoverWorkspaceCandidates();
  let bestMatch = null;

  for (const candidate of candidates) {
    const score = scoreWorkspaceCandidate(title, candidate);

    if (score < 8) {
      continue;
    }

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        ...candidate,
        score,
      };
    }
  }

  return bestMatch;
}

function normalizePathToken(token) {
  return token.replace(/^[("'`]+|[)"'`,.:;!?]+$/g, "");
}

function extractPathTokens(title) {
  return title
    .split(/\s+/)
    .map(normalizePathToken)
    .filter(
      (token) =>
        token.startsWith("~/") ||
        token.startsWith("/") ||
        /^[a-zA-Z]:[\\/]/.test(token),
    );
}

function explicitPathCandidates(token) {
  const candidates = new Set();

  if (token.startsWith("~/")) {
    candidates.add(path.join(os.homedir(), token.slice(2)));
  } else if (token.startsWith("/")) {
    candidates.add(token);
    candidates.add(path.join(os.homedir(), token.slice(1)));
  } else if (/^[a-zA-Z]:[\\/]/.test(token)) {
    candidates.add(token);
  }

  return [...candidates];
}

async function findWorkspaceByBasename(name) {
  if (!name) {
    return null;
  }

  const normalizedName = collapseWorkspaceText(name);
  if (!normalizedName) {
    return null;
  }

  const candidates = await discoverWorkspaceCandidates();

  for (const candidate of candidates) {
    if (collapseWorkspaceText(candidate.name) === normalizedName) {
      return candidate;
    }
  }

  return null;
}

async function resolveExplicitWorkspace(title) {
  const tokens = extractPathTokens(title);

  for (const token of tokens) {
    for (const candidate of explicitPathCandidates(token)) {
      if (await isDirectory(candidate)) {
        return {
          root: path.dirname(candidate),
          taskDir: candidate,
          source: "explicit",
        };
      }
    }

    const basename = path.basename(token.replace(/\/+$/g, ""));
    const matchedByName = await findWorkspaceByBasename(basename);
    if (matchedByName) {
      return {
        root: matchedByName.root,
        taskDir: matchedByName.dir,
        source: "explicit",
      };
    }
  }

  return null;
}

async function resolveTaskWorkspace(title) {
  const explicitWorkspace = await resolveExplicitWorkspace(title);

  if (explicitWorkspace) {
    return explicitWorkspace;
  }

  const matchedWorkspace = await findMatchedWorkspace(title);

  if (matchedWorkspace) {
    return {
      root: matchedWorkspace.root,
      taskDir: matchedWorkspace.dir,
      source: "matched",
    };
  }

  return null;
}

function isOutsideWorkspace(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && (relative.startsWith("..") || path.isAbsolute(relative));
}

async function resolveCodexCommand() {
  return codexEnv.resolveCodexCommand({
    app,
    env: process.env,
  });
}

async function buildCodexInfo() {
  return codexEnv.buildCodexInfo({
    app,
    env: process.env,
  });
}

async function connectCodexBinary() {
  const selection = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: "Select Codex executable",
    properties: ["openFile"],
    buttonLabel: "Connect",
    defaultPath: app.getPath("home"),
  });

  if (selection.canceled || selection.filePaths.length === 0) {
    return null;
  }

  const selectedPath = selection.filePaths[0];
  const probe = await new Promise((resolve) => {
    const child = spawn(selectedPath, ["--version"], {
      stdio: "ignore",
    });

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });

  if (!probe) {
    throw new Error("Selected file is not a working Codex executable.");
  }

  const config = await readAppConfig();
  config.codexBin = selectedPath;
  await writeAppConfig(config);

  return buildCodexInfo();
}

function isEmulatorMode() {
  return process.env.ME_EMULATOR === "1";
}

async function replaceAllTasks(tasks) {
  const nextTasks = await sendBackendRequest("replace_all", { tasks });
  broadcastTasks(nextTasks);
  return nextTasks;
}

async function runEmulatorAction({ action, title }) {
  if (!isEmulatorMode()) {
    throw new Error("Emulator toolbox is only available in emulator mode.");
  }

  if (action === "seed-demo") {
    return replaceAllTasks(emulatorLib.buildSeedTasks("demo"));
  }

  if (action === "clear-all") {
    return replaceAllTasks([]);
  }

  if (!action.startsWith("add-")) {
    throw new Error(`Unknown emulator action: ${action}`);
  }

  const shortcut = action.slice(4);

  if (!emulatorLib.TOOLBOX_SHORTCUTS.includes(shortcut)) {
    throw new Error(`Unknown emulator shortcut: ${shortcut}`);
  }

  const currentTasks = await sendBackendRequest("list");
  const nextTask = emulatorLib.buildShortcutTask({
    shortcut,
    title,
    runnerPid: process.pid,
  });

  return replaceAllTasks([nextTask, ...currentTasks]);
}

function compactPromptText(value, maxChars = 4_000) {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}\n...[truncated]`;
}

async function loadPersonalizationContext() {
  const files = await ensurePersonalizationFiles();
  const agents = compactPromptText(await readOptionalFile(files.agentsPath));
  const profile = compactPromptText(await readOptionalFile(files.profilePath));

  return {
    ...files,
    agents,
    profile,
  };
}

function buildCodexPrompt({
  id,
  title,
  runnerRoot,
  targetWorkspace,
  workspaceSource,
  personalization,
}) {
  const resolvedTarget = targetWorkspace || "not resolved";
  const resolvedSource = workspaceSource || "runner";
  const agentsPath = personalization?.agentsPath || personalAgentsPath();
  const profilePath = personalization?.profilePath || personalProfilePath();
  const personalAgents = personalization?.agents;
  const personalProfile = personalization?.profile;

  return [
    "A task was registered in the Me desktop app and has been assigned to you automatically.",
    "",
    `Task ID: ${id}`,
    `Task: ${title}`,
    `Runner workspace: ${runnerRoot}`,
    `Target workspace: ${resolvedTarget}`,
    `Workspace source: ${resolvedSource}`,
    `Personal instructions path: ${agentsPath}`,
    `Personal profile path: ${profilePath}`,
    "",
    "Use the runner workspace only for coordination. Do not create project files there.",
    "If a target workspace is resolved, inspect and modify that workspace only.",
    "If a target workspace is not resolved, try to identify the correct existing folder from the task text and do not create project files in the runner workspace.",
    "Use the personal instructions and profile to personalize planning, execution defaults, and final summaries.",
    "Run relevant verification when possible and finish with a concise summary for the Me app.",
    "Do not wait for more user input.",
    "",
    "Personal Instructions:",
    personalAgents || "No personal instructions were provided.",
    "",
    "Personal Profile:",
    personalProfile || "No personal profile was provided.",
  ].join("\n");
}

function formatCodexStdoutLine(line) {
  let payload;

  try {
    payload = JSON.parse(line);
  } catch {
    return { logLine: `[stdout] ${line}\n`, agentText: null };
  }

  switch (payload.type) {
    case "thread.started":
      return {
        logLine: `[thread] started ${payload.thread_id}\n`,
        agentText: null,
      };
    case "turn.started":
      return { logLine: "[turn] started\n", agentText: null };
    case "turn.completed":
      return { logLine: "[turn] completed\n", agentText: null };
    case "item.completed": {
      if (payload.item?.type === "agent_message") {
        const text = normalizeText(payload.item.text);
        return {
          logLine: text ? `[message] ${text}\n` : "[message]\n",
          agentText: text,
        };
      }

      return {
        logLine: `[item] ${payload.item?.type || "completed"}\n`,
        agentText: null,
      };
    }
    default:
      return {
        logLine: `[event] ${payload.type}\n`,
        agentText: null,
      };
  }
}

function normalizeText(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function broadcastTasks(tasks) {
  const signature = JSON.stringify(tasks);

  if (signature === lastTasksSignature) {
    return;
  }

  lastTasksSignature = signature;

  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("tasks:updated", tasks);
}

function isCodexTaskActive(task) {
  return task?.codex_status === "queued" || task?.codex_status === "running";
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function appendCodexLog(id, chunk) {
  if (!chunk) {
    return;
  }

  const tasks = await sendBackendRequest("codex_append_log", { id, chunk });
  broadcastTasks(tasks);
}

async function failCodexTask(id, message) {
  await appendCodexLog(id, `[error] ${message}\n`);
  const tasks = await sendBackendRequest("codex_set_result", {
    id,
    success: false,
    output: null,
    error: message,
  });
  broadcastTasks(tasks);
  return tasks;
}

async function buildDetachedRunnerSpec({ id, title, workspace, trigger = "manual" }) {
  const codexCommand = await resolveCodexCommand();

  if (!codexCommand) {
    throw new Error("Codex CLI was not found on this machine.");
  }

  const runnerRoot = await ensureDirectory(defaultCodexWorkspaceRoot());
  const personalization = await ensurePersonalizationFiles();
  const resolvedWorkspace = workspace || (await resolveTaskWorkspace(title));
  const targetWorkspace = resolvedWorkspace?.taskDir || null;
  const backend = resolveBackendCommand();

  return {
    id,
    title,
    trigger,
    codexCommand,
    runnerRoot,
    targetWorkspace,
    workspaceRoot: resolvedWorkspace?.root || null,
    workspaceSource: resolvedWorkspace?.source || "runner",
    personalAgentsPath: personalization.agentsPath,
    personalProfilePath: personalization.profilePath,
    backendCommand: backend.command,
    backendArgs: backend.args,
  };
}

async function launchDetachedCodexRunner(task, trigger = "manual") {
  const spec = await buildDetachedRunnerSpec({
    ...task,
    trigger,
  });

  await ensureDirectory(codexRunsPath());

  const specPath = codexRunSpecPath(spec.id);
  await fs.writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");

  const runnerScriptPath = path.join(app.getAppPath(), "electron", "codex-runner.js");
  const child = spawn(process.execPath, [runnerScriptPath, specPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  child.unref();

  const tasks = await sendBackendRequest("codex_mark_queued", {
    id: spec.id,
    workspace: spec.targetWorkspace || spec.runnerRoot,
    workspace_source: spec.workspaceSource,
    runner_pid: child.pid || null,
  });
  broadcastTasks(tasks);
  return tasks;
}

async function reconcileDetachedCodexTasks(tasks = null) {
  let currentTasks = tasks || (await sendBackendRequest("list"));

  for (const task of currentTasks) {
    if (!isCodexTaskActive(task)) {
      continue;
    }

    if (task.codex_runner_pid && isProcessAlive(task.codex_runner_pid)) {
      continue;
    }

    currentTasks = await sendBackendRequest("codex_set_result", {
      id: task.id,
      success: false,
      output: null,
      error: "Codex session ended before the task completed.",
    });
  }

  return currentTasks;
}

async function syncDetachedTaskState() {
  if (!backendProcess) {
    return;
  }

  let tasks = await sendBackendRequest("list");
  tasks = await reconcileDetachedCodexTasks(tasks);
  broadcastTasks(tasks);
}

function startTaskMonitor() {
  if (taskMonitorTimer) {
    return;
  }

  taskMonitorTimer = setInterval(() => {
    void syncDetachedTaskState().catch((error) => {
      console.error("Failed to sync detached Codex tasks:", error);
    });
  }, TASK_MONITOR_INTERVAL_MS);
}

function stopTaskMonitor() {
  if (!taskMonitorTimer) {
    return;
  }

  clearInterval(taskMonitorTimer);
  taskMonitorTimer = null;
}

function startCodexTask(task, trigger = "manual") {
  if (activeCodexTaskIds.has(task.id)) {
    return sendBackendRequest("list");
  }

  activeCodexTaskIds.add(task.id);

  const startPromise = sendBackendRequest("list")
    .then((tasks) => {
      const existingTask = tasks.find((entry) => entry.id === task.id);

      if (
        existingTask &&
        isCodexTaskActive(existingTask) &&
        existingTask.codex_runner_pid &&
        isProcessAlive(existingTask.codex_runner_pid)
      ) {
        return tasks;
      }

      return launchDetachedCodexRunner(task, trigger);
    })
    .catch(async (error) => {
      const message =
        error instanceof Error ? error.message : "Codex execution failed.";

      try {
        await failCodexTask(task.id, message);
      } catch (persistError) {
        console.error("Failed to persist Codex task failure:", persistError);
      }
    })
    .finally(() => {
      activeCodexTaskIds.delete(task.id);
    });

  return startPromise;
}

function startBackend() {
  if (backendProcess) {
    return;
  }

  const { command, args } = resolveBackendCommand();
  backendProcess = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const output = readline.createInterface({
    input: backendProcess.stdout,
    crlfDelay: Infinity,
  });

  output.on("line", (line) => {
    let response;

    try {
      response = JSON.parse(line);
    } catch (error) {
      console.error("Failed to parse backend response:", error);
      return;
    }

    const request = pendingRequests.get(response.request_id);

    if (!request) {
      return;
    }

    pendingRequests.delete(response.request_id);

    if (response.success) {
      request.resolve(response.tasks);
      return;
    }

    request.reject(new Error(response.error || "Unknown backend error"));
  });

  backendProcess.stderr.on("data", (chunk) => {
    console.error(`[backend] ${chunk.toString().trim()}`);
  });

  backendProcess.on("exit", (code, signal) => {
    backendProcess = null;
    rejectAllPending(
      `Rust backend exited unexpectedly (code: ${code ?? "null"}, signal: ${signal ?? "null"})`,
    );
  });

  backendProcess.on("error", (error) => {
    backendProcess = null;
    rejectAllPending(`Failed to start Rust backend: ${error.message}`);
  });
}

function stopBackend() {
  if (!backendProcess) {
    return;
  }

  backendProcess.kill();
  backendProcess = null;
}

function sendBackendRequest(action, payload = {}) {
  if (!backendProcess) {
    throw new Error("Rust backend is not running");
  }

  const requestId = crypto.randomUUID();
  const message = JSON.stringify({
    request_id: requestId,
    action,
    ...payload,
  });

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    backendProcess.stdin.write(`${message}\n`, (error) => {
      if (!error) {
        return;
      }

      pendingRequests.delete(requestId);
      reject(error);
    });
  });
}

function registerIpcHandlers() {
  ipcMain.handle("tasks:list", () => sendBackendRequest("list"));
  ipcMain.handle("tasks:add", async (_event, payload) => {
    const tasks = await sendBackendRequest("add", payload);
    broadcastTasks(tasks);

    const task = tasks[0];
    if (task) {
      try {
        return await startCodexTask({ id: task.id, title: task.title }, "auto");
      } catch (error) {
        console.error("Failed to start Codex task:", error);
      }
    }

    return tasks;
  });
  ipcMain.handle("tasks:complete", (_event, id) =>
    sendBackendRequest("complete", { id }),
  );
  ipcMain.handle("tasks:delete", (_event, id) =>
    sendBackendRequest("delete", { id }),
  );
  ipcMain.handle("tasks:run-codex", (_event, payload) => startCodexTask(payload));
  ipcMain.handle("emulator:action", (_event, payload) => runEmulatorAction(payload));
  ipcMain.handle("codex:info", () => buildCodexInfo());
  ipcMain.handle("codex:connect", async () => {
    const info = await connectCodexBinary();
    return info || buildCodexInfo();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: "#0f172a",
    title: "Me",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  startBackend();
  registerIpcHandlers();
  startTaskMonitor();
  createWindow();
  void syncDetachedTaskState().catch((error) => {
    console.error("Failed to initialize detached Codex task sync:", error);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopTaskMonitor();
  stopBackend();
});
