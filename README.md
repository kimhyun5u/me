# Me

Cross-platform desktop task manager built with Electron and Rust.

## Stack

- Electron for the desktop shell and renderer UI
- Rust for task storage, CRUD logic, and local persistence
- JSON file storage in the platform-specific app data directory

## Features

- Add tasks from a single text input
- Automatically start each new task in the local terminal Codex CLI
- Keep Codex tasks running even if the Electron app closes
- Keep the latest Codex status and response on each task
- List tasks
- Delete tasks

## Codex integration

- New tasks are started automatically as soon as they are added
- Different tasks can run in parallel
- Each task is launched in a detached local runner so it can keep running after the app exits
- When the app starts again, it reloads in-progress task state from storage and continues tracking live updates
- Tasks whose detached runner died unexpectedly are marked as failed instead of staying stuck in `running`
- Explicit paths in the task text such as `/projects/me` or `~/projects/me` are resolved to the corresponding local folder first
- If no explicit path is present, the app routes the task into the best matching local workspace automatically
- The latest Codex status, timestamp, and response are stored with the task
- Personal instructions are loaded from `~/.me/AGENTS.md`
- Personal profile data is loaded from `~/.me/profile.md`
- A configured Codex binary path can be stored in `~/.me/config.json`

Requirements:

- `codex` must be installed locally and reachable from the app
- If the binary is not on the default path, launch the app with `CODEX_BIN=/path/to/codex`

The app runs Codex from `~/.me` as the control workspace. `~/.me` is reserved for Me app data, detached runner specs, personal instructions, and coordination only. When the task points to another local workspace, that path is added as an extra writable directory and used as the target workspace. If no target workspace is resolved, Codex stays in the runner workspace and is instructed not to create project files there.

Personalization files:

- `~/.me/AGENTS.md`: stable personal instructions and execution defaults
- `~/.me/profile.md`: personal profile, preferences, and project context

If these files do not exist, the app creates starter versions automatically.

If Codex is missing, use the in-app `Connect Codex` action to select an existing local Codex executable. The selected path is stored in `~/.me/config.json` and reused on the next launch.

## Run locally

```bash
npm install
npm run dev
```

The `dev` script builds the Rust backend in debug mode and then launches Electron.

## Test the Rust backend

```bash
npm run test:backend
```

## Test Codex scenarios

Automated environment checks:

```bash
npm run test:scenarios
```

Manual isolated app scenarios:

```bash
npm run scenario:codex-missing
npm run scenario:codex-broken-config
npm run scenario:codex-fake
```

These scenario launchers use a temporary `ME_HOME_DIR` so you can test Codex setup states without touching your real `~/.me`.

## Package the desktop app

Build the release Rust binary first and package per target OS:

```bash
npm run dist:mac
npm run dist:win
```

In practice, macOS packages are best built on macOS and Windows installers are best built on Windows or in CI with a Windows runner.
