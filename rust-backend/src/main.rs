use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use task_backend::{Task, TaskStore};

#[derive(Debug, Deserialize)]
struct CommandEnvelope {
    request_id: String,
    #[serde(flatten)]
    command: Command,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum Command {
    #[serde(rename = "list")]
    List,
    #[serde(rename = "add")]
    Add {
        title: String,
        #[serde(default, alias = "pipeline", alias = "importType")]
        import_type: Option<String>,
    },
    #[serde(rename = "complete")]
    Complete { id: String },
    #[serde(rename = "delete")]
    Delete { id: String },
    #[serde(rename = "codex_mark_queued")]
    CodexMarkQueued {
        id: String,
        #[serde(default)]
        workspace: Option<String>,
        #[serde(default)]
        workspace_source: Option<String>,
    },
    #[serde(rename = "codex_mark_running")]
    CodexMarkRunning {
        id: String,
        #[serde(default)]
        workspace: Option<String>,
        #[serde(default)]
        workspace_source: Option<String>,
    },
    #[serde(rename = "codex_append_log")]
    CodexAppendLog { id: String, chunk: String },
    #[serde(rename = "codex_set_result")]
    CodexSetResult {
        id: String,
        success: bool,
        #[serde(default)]
        output: Option<String>,
        #[serde(default)]
        error: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct CommandResponse {
    request_id: String,
    success: bool,
    tasks: Vec<Task>,
    error: Option<String>,
}

fn main() -> Result<()> {
    let store = TaskStore::for_app()?;
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;

        if line.trim().is_empty() {
            continue;
        }

        let envelope: Result<CommandEnvelope, _> = serde_json::from_str(&line);

        match envelope {
            Ok(request) => {
                let result = match request.command {
                    Command::List => store.list(),
                    Command::Add { title, import_type } => {
                        store.add(&title, import_type.as_deref())
                    }
                    Command::Complete { id } => store.complete(&id),
                    Command::Delete { id } => store.delete(&id),
                    Command::CodexMarkQueued {
                        id,
                        workspace,
                        workspace_source,
                    } => store.mark_codex_queued(
                        &id,
                        workspace.as_deref(),
                        workspace_source.as_deref(),
                    ),
                    Command::CodexMarkRunning {
                        id,
                        workspace,
                        workspace_source,
                    } => store.mark_codex_running(
                        &id,
                        workspace.as_deref(),
                        workspace_source.as_deref(),
                    ),
                    Command::CodexAppendLog { id, chunk } => store.append_codex_log(&id, &chunk),
                    Command::CodexSetResult {
                        id,
                        success,
                        output,
                        error,
                    } => store.set_codex_result(&id, success, output.as_deref(), error.as_deref()),
                };

                let response = match result {
                    Ok(tasks) => CommandResponse {
                        request_id: request.request_id,
                        success: true,
                        tasks,
                        error: None,
                    },
                    Err(error) => CommandResponse {
                        request_id: request.request_id,
                        success: false,
                        tasks: Vec::new(),
                        error: Some(error.to_string()),
                    },
                };

                serde_json::to_writer(&mut stdout, &response)?;
                writeln!(&mut stdout)?;
                stdout.flush()?;
            }
            Err(error) => {
                let response = CommandResponse {
                    request_id: "invalid-request".to_owned(),
                    success: false,
                    tasks: Vec::new(),
                    error: Some(format!("invalid command: {error}")),
                };

                serde_json::to_writer(&mut stdout, &response)?;
                writeln!(&mut stdout)?;
                stdout.flush()?;
            }
        }
    }

    Ok(())
}
