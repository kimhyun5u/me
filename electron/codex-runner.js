const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function normalizeText(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function loadPersonalizationContext(spec) {
  const agents = compactPromptText(await readOptionalFile(spec.personalAgentsPath));
  const profile = compactPromptText(await readOptionalFile(spec.personalProfilePath));

  return {
    agents,
    profile,
  };
}

function buildCodexPrompt(spec, personalization) {
  const resolvedTarget = spec.targetWorkspace || "not resolved";
  const resolvedSource = spec.workspaceSource || "runner";

  return [
    "A task was registered in the Me desktop app and has been assigned to you automatically.",
    "",
    `Task ID: ${spec.id}`,
    `Task: ${spec.title}`,
    `Runner workspace: ${spec.runnerRoot}`,
    `Target workspace: ${resolvedTarget}`,
    `Workspace source: ${resolvedSource}`,
    `Personal instructions path: ${spec.personalAgentsPath}`,
    `Personal profile path: ${spec.personalProfilePath}`,
    "",
    "Use the runner workspace only for coordination. Do not create project files there.",
    "If a target workspace is resolved, inspect and modify that workspace only.",
    "If a target workspace is not resolved, try to identify the correct existing folder from the task text and do not create project files in the runner workspace.",
    "Use the personal instructions and profile to personalize planning, execution defaults, and final summaries.",
    "Run relevant verification when possible and finish with a concise summary for the Me app.",
    "Do not wait for more user input.",
    "",
    "Personal Instructions:",
    personalization.agents || "No personal instructions were provided.",
    "",
    "Personal Profile:",
    personalization.profile || "No personal profile was provided.",
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

function isOutsideWorkspace(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && (relative.startsWith("..") || path.isAbsolute(relative));
}

function startBackendClient(spec) {
  const backendProcess = spawn(spec.backendCommand, spec.backendArgs || [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pendingRequests = new Map();
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
    console.error(`[runner-backend] ${chunk.toString().trim()}`);
  });

  backendProcess.on("exit", (code, signal) => {
    for (const { reject } of pendingRequests.values()) {
      reject(
        new Error(
          `Runner backend exited unexpectedly (code: ${code ?? "null"}, signal: ${signal ?? "null"})`,
        ),
      );
    }
    pendingRequests.clear();
  });

  function sendBackendRequest(action, payload = {}) {
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  return {
    sendBackendRequest,
    stop() {
      output.close();
      backendProcess.kill();
    },
  };
}

async function runTask(spec, specPath) {
  const backend = startBackendClient(spec);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "me-codex-"));
  const outputFile = path.join(tempDir, "last-message.txt");

  try {
    const personalization = await loadPersonalizationContext(spec);
    const targetWorkspace = spec.targetWorkspace || null;
    const extraWritableTarget =
      Boolean(targetWorkspace) && isOutsideWorkspace(spec.runnerRoot, targetWorkspace);
    const sandboxMode = targetWorkspace ? "workspace-write" : "read-only";
    const prompt = buildCodexPrompt(spec, personalization);
    let logQueue = Promise.resolve();

    const queueLog = (chunk) => {
      logQueue = logQueue
        .then(() =>
          backend.sendBackendRequest("codex_append_log", {
            id: spec.id,
            chunk,
          }),
        )
        .catch((error) => {
          console.error("Failed to append Codex log:", error);
        });
    };

    await backend.sendBackendRequest("codex_mark_running", {
      id: spec.id,
      workspace: targetWorkspace || spec.runnerRoot,
      workspace_source: spec.workspaceSource || "runner",
      runner_pid: process.pid,
    });

    queueLog(
      `[trigger] ${spec.trigger}\n[run] starting Codex\n[binary] ${spec.codexCommand}\n[sandbox] ${sandboxMode}\n[runner-workspace] ${spec.runnerRoot}\n[target-source] ${spec.workspaceSource || "runner"}\n[target-root] ${spec.workspaceRoot || "not resolved"}\n[target-workspace] ${targetWorkspace || "not resolved"}\n[personal-agents] ${spec.personalAgentsPath}\n[personal-profile] ${spec.personalProfilePath}\n`,
    );

    const result = await new Promise((resolve) => {
      const args = [
        "exec",
        "--json",
        "--full-auto",
        "--sandbox",
        sandboxMode,
        "--skip-git-repo-check",
        "--color",
        "never",
        "-C",
        spec.runnerRoot,
        "-o",
        outputFile,
      ];

      if (extraWritableTarget) {
        args.push("--add-dir", targetWorkspace);
      }

      args.push(prompt);

      const child = spawn(spec.codexCommand, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";
      let lastAgentMessage = null;
      let settled = false;

      const flushStdoutLines = (flushPartial = false) => {
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = flushPartial ? "" : lines.pop() || "";

        for (const line of flushPartial ? lines.filter(Boolean) : lines) {
          if (!line.trim()) {
            continue;
          }

          const { logLine, agentText } = formatCodexStdoutLine(line);

          if (agentText) {
            lastAgentMessage = agentText;
          }

          queueLog(logLine);
        }
      };

      const flushStderrLines = (flushPartial = false) => {
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = flushPartial ? "" : lines.pop() || "";

        for (const line of flushPartial ? lines.filter(Boolean) : lines) {
          if (!line.trim()) {
            continue;
          }

          queueLog(`[stderr] ${line}\n`);
        }
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        flushStdoutLines();
      });

      child.stderr.on("data", (chunk) => {
        stderrBuffer += chunk.toString();
        flushStderrLines();
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }

        settled = true;
        queueLog(`[error] ${error.message}\n`);
        resolve({
          success: false,
          output: null,
          error: error.message,
        });
      });

      child.on("exit", async (code, signal) => {
        if (settled) {
          return;
        }

        settled = true;
        flushStdoutLines(true);
        flushStderrLines(true);

        const lastMessage = normalizeText(await readOptionalFile(outputFile));
        const output = lastMessage || lastAgentMessage;
        const error =
          code === 0
            ? null
            : `Codex exited with code ${code ?? "null"}${signal ? ` and signal ${signal}` : ""}`;

        if (error) {
          queueLog(`[exit] ${error}\n`);
        } else {
          queueLog("[exit] completed\n");
        }

        resolve({
          success: code === 0,
          output,
          error,
        });
      });
    });

    await logQueue;
    await backend.sendBackendRequest("codex_set_result", {
      id: spec.id,
      success: result.success,
      output: result.output,
      error: result.error,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex execution failed.";

    try {
      await backend.sendBackendRequest("codex_append_log", {
        id: spec.id,
        chunk: `[error] ${message}\n`,
      });
      await backend.sendBackendRequest("codex_set_result", {
        id: spec.id,
        success: false,
        output: null,
        error: message,
      });
    } catch (persistError) {
      console.error("Failed to persist runner failure:", persistError);
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(specPath, { force: true });
    backend.stop();
  }
}

async function main() {
  const specPath = process.argv[2];

  if (!specPath) {
    throw new Error("Missing runner spec path.");
  }

  const raw = await fs.readFile(specPath, "utf8");
  const spec = JSON.parse(raw);

  await runTask(spec, specPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
