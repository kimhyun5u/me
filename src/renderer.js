const shell = document.querySelector(".shell");
const form = document.getElementById("task-form");
const textInput = document.getElementById("task-text");
const codexChip = document.getElementById("codex-chip");
const connectCodexButton = document.getElementById("connect-codex-button");
const addButton = document.getElementById("add-button");
const refreshButton = document.getElementById("refresh-button");
const totalCount = document.getElementById("total-count");
const openCount = document.getElementById("open-count");
const doneCount = document.getElementById("done-count");
const taskList = document.getElementById("task-list");
const taskTemplate = document.getElementById("task-template");
const emptyTemplate = document.getElementById("empty-template");
const formError = document.getElementById("form-error");
const emulatorToolbox = document.getElementById("emulator-toolbox");
const toolboxMeta = document.getElementById("toolbox-meta");
const toolboxText = document.getElementById("toolbox-text");
const toolboxButtons = Array.from(document.querySelectorAll(".toolbox-button"));

const CODEX_STATUS = {
  idle: "Codex Idle",
  queued: "Codex Queued",
  running: "Codex Running",
  succeeded: "Codex Ready",
  failed: "Codex Failed",
};

let tasks = [];
let busy = false;
const followingLogTaskIds = new Set();
let codexInfo = {
  available: false,
  command: null,
  defaultWorkspace: "",
  emulator: {
    enabled: false,
    profile: null,
    seed: null,
  },
};

function setBusy(nextBusy) {
  busy = nextBusy;
  addButton.disabled = nextBusy;
  connectCodexButton.disabled = nextBusy;
  refreshButton.disabled = nextBusy;
  textInput.disabled = nextBusy;
  toolboxText.disabled = nextBusy;

  for (const button of taskList.querySelectorAll("button")) {
    button.disabled = nextBusy;
  }

  for (const button of toolboxButtons) {
    button.disabled = nextBusy;
  }
}

function formatDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function codexStatusLabel(status) {
  return CODEX_STATUS[status] || "Codex Idle";
}

function logKindLabel(kind) {
  return kind
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseCodexLog(logText) {
  return logText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\[([^\]]+)\]\s?(.*)$/);

      if (!match) {
        return null;
      }

      if (match[1] !== "message") {
        return null;
      }

      return {
        kind: "message",
        message: match[2] || logKindLabel(match[1]),
      };
    })
    .filter(Boolean);
}

function renderCodexLog(container, logText) {
  container.replaceChildren();

  const entries = parseCodexLog(logText);
  if (entries.length === 0) {
    container.hidden = true;
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const entry of entries) {
    const message = document.createElement("p");

    message.className = "task-log-message";
    message.textContent = entry.message;

    fragment.appendChild(message);
  }

  container.appendChild(fragment);
  container.hidden = false;
}

function renderCodexOutput(container, value, isError) {
  container.replaceChildren();

  if (!value) {
    container.hidden = true;
    container.classList.remove("is-error");
    return;
  }

  const label = document.createElement("span");
  const body = document.createElement("p");

  label.className = "task-output-label";
  label.textContent = isError ? "Error" : "Result";
  body.className = "task-output-body";
  body.textContent = value;

  container.classList.toggle("is-error", isError);
  container.append(label, body);
  container.hidden = false;
}

function isNearLogBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= 12;
}

function scrollLogToBottom(container) {
  container.scrollTop = container.scrollHeight;
}

function setLogFollowState(container, taskId, shouldFollow) {
  if (shouldFollow) {
    followingLogTaskIds.add(taskId);
  } else {
    followingLogTaskIds.delete(taskId);
  }

  container.dataset.follow = shouldFollow ? "true" : "false";
  container.title = shouldFollow ? "Following latest logs" : "Click to follow latest logs";
}

function bindLogInteractions(container, taskId) {
  setLogFollowState(container, taskId, followingLogTaskIds.has(taskId));

  container.addEventListener("click", () => {
    setLogFollowState(container, taskId, true);
    scrollLogToBottom(container);
  });

  container.addEventListener("scroll", () => {
    if (!followingLogTaskIds.has(taskId)) {
      return;
    }

    if (!isNearLogBottom(container)) {
      setLogFollowState(container, taskId, false);
    }
  });
}

function renderCodexInfo() {
  codexChip.textContent = codexInfo.available ? "Codex Ready" : "Codex Missing";
  codexChip.dataset.state = codexInfo.available ? "connected" : "missing";
  codexChip.title = codexInfo.command || codexInfo.configuredCommand || "Codex CLI not found";

  connectCodexButton.hidden = codexInfo.available;
  connectCodexButton.textContent = codexInfo.configuredCommand
    ? "Reconnect Codex"
    : "Connect Codex";
}

function renderEmulatorToolbox() {
  const emulator = codexInfo.emulator || {};
  const enabled = Boolean(emulator.enabled);

  emulatorToolbox.hidden = !enabled;
  shell.dataset.mode = enabled ? "emulator" : "default";

  if (!enabled) {
    toolboxMeta.textContent = "";
    toolboxText.value = "";
    return;
  }

  const metaParts = [];

  if (emulator.profile) {
    metaParts.push(`Profile ${emulator.profile}`);
  }

  if (emulator.seed) {
    metaParts.push(`Seed ${emulator.seed}`);
  }

  toolboxMeta.textContent = metaParts.join(" · ");
}

function renderStats() {
  const completed = tasks.filter((task) => task.completed).length;

  totalCount.textContent = String(tasks.length);
  doneCount.textContent = String(completed);
  openCount.textContent = String(tasks.length - completed);
}

function renderList() {
  taskList.replaceChildren();
  renderStats();

  if (tasks.length === 0) {
    taskList.appendChild(emptyTemplate.content.cloneNode(true));
    return;
  }

  for (const task of tasks) {
    const fragment = taskTemplate.content.cloneNode(true);
    const item = fragment.querySelector(".task-item");
    const title = fragment.querySelector(".task-title");
    const status = fragment.querySelector(".task-status");
    const codexStatus = fragment.querySelector(".task-codex-status");
    const date = fragment.querySelector(".task-date");
    const workspace = fragment.querySelector(".task-workspace");
    const codexLog = fragment.querySelector(".task-codex-log");
    const codexRun = fragment.querySelector(".task-codex-run");
    const codexOutput = fragment.querySelector(".task-codex-output");
    const deleteButton = fragment.querySelector(".delete-button");

    title.textContent = task.title;
    status.textContent = task.completed ? "Done" : "Open";
    codexStatus.textContent = codexStatusLabel(task.codex_status);
    codexStatus.dataset.state = task.codex_status;
    date.textContent = formatDate(task.created_at);
    item.dataset.taskId = task.id;

    if (task.completed) {
      item.classList.add("is-complete");
    }

    if (task.codex_last_run_at) {
      codexRun.hidden = true;
    }

    workspace.hidden = true;

    if (task.codex_log) {
      renderCodexLog(codexLog, task.codex_log);
      bindLogInteractions(codexLog, task.id);

      if (followingLogTaskIds.has(task.id)) {
        queueMicrotask(() => {
          scrollLogToBottom(codexLog);
        });
      }
    } else {
      codexLog.replaceChildren();
      followingLogTaskIds.delete(task.id);
      codexLog.hidden = true;
    }

    codexOutput.hidden = true;

    deleteButton.addEventListener("click", () => deleteTask(task.id));

    taskList.appendChild(fragment);
  }

  if (busy) {
    setBusy(true);
  }
}

function showFormError(message = "") {
  formError.textContent = message;
}

async function withRequest(work) {
  setBusy(true);
  showFormError("");

  try {
    await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    showFormError(message);
  } finally {
    setBusy(false);
    renderList();
  }
}

async function refreshTasks() {
  await withRequest(async () => {
    tasks = await window.tasksApi.list();
    renderList();
  });
}

async function loadCodexInfo() {
  codexInfo = await window.tasksApi.getCodexInfo();

  renderCodexInfo();
  renderEmulatorToolbox();
  renderList();
}

async function connectCodex() {
  await withRequest(async () => {
    const nextInfo = await window.tasksApi.connectCodex();
    if (nextInfo) {
      codexInfo = nextInfo;
    }

    renderCodexInfo();
    renderEmulatorToolbox();
    renderList();
  });
}

async function runEmulatorAction(action) {
  await withRequest(async () => {
    tasks = await window.tasksApi.emulatorAction({
      action,
      title: toolboxText.value,
    });

    if (action.startsWith("add-")) {
      toolboxText.select();
    }

    renderList();
  });
}

async function addTask(text) {
  await withRequest(async () => {
    tasks = await window.tasksApi.add({ title: text });
    textInput.value = "";
    textInput.focus();
    renderList();
  });
}

async function deleteTask(id) {
  await withRequest(async () => {
    tasks = await window.tasksApi.remove(id);
    renderList();
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = textInput.value;

  if (!text.trim()) {
    showFormError("Enter text.");
    textInput.focus();
    return;
  }

  await addTask(text);
});

refreshButton.addEventListener("click", refreshTasks);
connectCodexButton.addEventListener("click", connectCodex);

for (const button of toolboxButtons) {
  button.addEventListener("click", () => runEmulatorAction(button.dataset.action));
}

toolboxText.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  void runEmulatorAction("add-open");
});

window.tasksApi.onTasksUpdated((nextTasks) => {
  tasks = nextTasks;
  renderList();
});

async function initialize() {
  await loadCodexInfo();
  await refreshTasks();
}

initialize().catch((error) => {
  showFormError(error instanceof Error ? error.message : "Initialization failed.");
});
