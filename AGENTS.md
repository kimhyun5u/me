# AGENTS.md

## Purpose

This repository contains `Me`, a desktop task manager built with:

- Electron for the desktop shell
- Vanilla HTML/CSS/JS for the renderer
- Rust for persistence and task state management

The goal of agent work in this repo is to make small, verifiable changes with clear Git hygiene.

## Working Rules

1. Start from an issue or create one first.
2. Write a short task plan before editing code.
3. Create a branch from the branch template.
4. Keep changes scoped to one issue.
5. Run the smallest relevant verification before finishing.
6. Open a PR with the PR template.
7. Merge with the merge template, preferably as a squash merge unless there is a reason not to.

## Default Request Flow

For future user requests in this repository, the default workflow is:

1. Turn the request into a GitHub issue first.
2. Write the task plan in the issue body or issue comments.
3. Create a branch that references the issue number.
4. Implement the change.
5. Run the smallest relevant verification.
6. Open a PR with the implemented change.
7. Merge the PR after verification unless the user explicitly asks to stop before merge.

If GitHub is available, prefer creating a real issue in `kimhyun5u/me` instead of keeping the work only in local notes.
Treat issue creation, branch work, PR creation, and merge as the default saved workflow for user requests in this repo.

## Task Plan Template

Use this plan shape for every issue and PR:

```md
## Plan

- Understand the current behavior
- Identify the minimum file set to change
- Implement the change
- Verify the result
- Document any follow-up work
```

## Repo Commands

Install dependencies:

```bash
npm install
```

Run the app locally:

```bash
npm run dev
```

Run Rust backend tests:

```bash
npm run test:backend
```

Useful syntax checks:

```bash
node --check electron/main.js
node --check src/renderer.js
```

## Branch Rules

Use one of these branch prefixes:

- `feature/<issue-id>-<slug>`
- `fix/<issue-id>-<slug>`
- `chore/<issue-id>-<slug>`
- `docs/<issue-id>-<slug>`
- `refactor/<issue-id>-<slug>`

Examples:

- `feature/42-codex-log-ui`
- `fix/87-workspace-resolution`
- `docs/103-github-templates`

If there is no issue number yet, create the issue first.

## Commit Rules

Use conventional commit style:

- `feat: add structured codex log cards`
- `fix: resolve explicit workspace paths`
- `docs: add github workflow templates`
- `refactor: simplify codex task execution`

Preferred format:

```text
<type>(optional-scope): <summary>
```

Keep the subject line under 72 characters when possible.

## PR Rules

Each PR should include:

- linked issue
- change summary
- verification steps
- risk or rollback notes

Prefer small PRs that are easy to review.

## Merge Rules

Before merging:

- confirm the PR scope matches the linked issue
- confirm the verification section is complete
- confirm screenshots or UI notes are included when the UI changed
- confirm there are no unrelated changes

Prefer squash merge with a clean final title derived from the PR title.

## Template Files

The repo includes these workflow templates:

- `.github/ISSUE_TEMPLATE/task.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/pull_request_template.md`
- `.github/commit-template.txt`
- `.github/branch-template.md`
- `.github/merge-template.md`

## Notes For Agents

- Do not treat `~/.me` as a project workspace. It is a control/data directory for the app.
- When a task mentions a concrete path such as `/projects/me`, resolve the real local folder first.
- Keep UI text minimal and functional.
- Prefer editing the smallest number of files needed for the task.
