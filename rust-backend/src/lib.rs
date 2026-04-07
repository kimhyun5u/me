use anyhow::{Context, Result, anyhow};
use chrono::Utc;
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn default_import_type() -> String {
    "quick-add".to_owned()
}

fn default_codex_status() -> String {
    "idle".to_owned()
}

fn default_codex_log() -> Option<String> {
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub completed: bool,
    pub created_at: String,
    #[serde(default = "default_import_type", alias = "pipeline")]
    pub import_type: String,
    #[serde(default = "default_codex_status")]
    pub codex_status: String,
    #[serde(default)]
    pub codex_last_run_at: Option<String>,
    #[serde(default)]
    pub codex_last_output: Option<String>,
    #[serde(default)]
    pub codex_last_error: Option<String>,
    #[serde(default = "default_codex_log")]
    pub codex_log: Option<String>,
    #[serde(default)]
    pub codex_workspace: Option<String>,
    #[serde(default)]
    pub codex_workspace_source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct TaskState {
    tasks: Vec<Task>,
}

pub struct TaskStore {
    file_path: PathBuf,
}

impl TaskStore {
    pub fn for_app() -> Result<Self> {
        let project_dirs =
            ProjectDirs::from("com", "kimhyun5u", "me").context("unsupported platform")?;

        Ok(Self::new(project_dirs.data_local_dir().join("tasks.json")))
    }

    pub fn new(file_path: PathBuf) -> Self {
        Self { file_path }
    }

    pub fn list(&self) -> Result<Vec<Task>> {
        let state = self.read_state()?;
        Ok(Self::sort_tasks(state.tasks))
    }

    pub fn add(&self, title: &str, import_type: Option<&str>) -> Result<Vec<Task>> {
        let mut state = self.read_state()?;
        state
            .tasks
            .push(Self::build_task(title, import_type, "quick-add")?);
        self.write_state(&state)?;
        Ok(Self::sort_tasks(state.tasks))
    }

    pub fn complete(&self, id: &str) -> Result<Vec<Task>> {
        let mut state = self.read_state()?;
        let task = state
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| anyhow!("Task not found"))?;

        task.completed = true;
        self.write_state(&state)?;
        Ok(Self::sort_tasks(state.tasks))
    }

    pub fn delete(&self, id: &str) -> Result<Vec<Task>> {
        let mut state = self.read_state()?;
        let original_len = state.tasks.len();
        state.tasks.retain(|task| task.id != id);

        if state.tasks.len() == original_len {
            return Err(anyhow!("Task not found"));
        }

        self.write_state(&state)?;
        Ok(Self::sort_tasks(state.tasks))
    }

    pub fn mark_codex_queued(
        &self,
        id: &str,
        workspace: Option<&str>,
        workspace_source: Option<&str>,
    ) -> Result<Vec<Task>> {
        let mut state = self.read_state()?;
        let task = state
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| anyhow!("Task not found"))?;

        task.codex_status = "queued".to_owned();
        task.codex_last_output = None;
        task.codex_last_error = None;
        task.codex_log = None;
        task.codex_workspace = workspace.map(str::to_owned);
        task.codex_workspace_source = workspace_source.map(str::to_owned);

        self.write_state(&state)?;
        Ok(Self::sort_tasks(state.tasks))
    }

    pub fn mark_codex_running(
        &self,
        id: &str,
        workspace: Option<&str>,
        workspace_source: Option<&str>,
    ) -> Result<Vec<Task>> {
        let mut state = self.read_state()?;
        let task = state
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| anyhow!("Task not found"))?;

        task.codex_status = "running".to_owned();
        task.codex_last_run_at = Some(Utc::now().to_rfc3339());
        task.codex_last_output = None;
        task.codex_last_error = None;
        task.codex_log = None;
        task.codex_workspace = workspace.map(str::to_owned);
        task.codex_workspace_source = workspace_source.map(str::to_owned);

        self.write_state(&state)?;
        Ok(Self::sort_tasks(state.tasks))
    }

    pub fn append_codex_log(&self, id: &str, chunk: &str) -> Result<Vec<Task>> {
        let mut state = self.read_state()?;
        let task = state
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| anyhow!("Task not found"))?;

        if chunk.is_empty() {
            return Ok(Self::sort_tasks(state.tasks));
        }

        let next = match &task.codex_log {
            Some(current) => format!("{current}{chunk}"),
            None => chunk.to_owned(),
        };

        task.codex_log = Some(Self::truncate_tail(&next, 12_000));

        self.write_state(&state)?;
        Ok(Self::sort_tasks(state.tasks))
    }

    pub fn set_codex_result(
        &self,
        id: &str,
        success: bool,
        output: Option<&str>,
        error: Option<&str>,
    ) -> Result<Vec<Task>> {
        let mut state = self.read_state()?;
        let task = state
            .tasks
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| anyhow!("Task not found"))?;

        task.codex_status = if success { "succeeded" } else { "failed" }.to_owned();
        task.codex_last_run_at = Some(Utc::now().to_rfc3339());
        task.codex_last_output = output.map(|value| Self::truncate_text(value, 4_000));
        task.codex_last_error = error.map(|value| Self::truncate_text(value, 2_000));

        self.write_state(&state)?;
        Ok(Self::sort_tasks(state.tasks))
    }

    fn read_state(&self) -> Result<TaskState> {
        if !self.file_path.exists() {
            return Ok(TaskState::default());
        }

        let raw = fs::read_to_string(&self.file_path)
            .with_context(|| format!("failed to read {}", self.file_path.display()))?;

        if raw.trim().is_empty() {
            return Ok(TaskState::default());
        }

        let state = serde_json::from_str::<TaskState>(&raw)
            .with_context(|| format!("failed to parse {}", self.file_path.display()))?;

        Ok(state)
    }

    fn write_state(&self, state: &TaskState) -> Result<()> {
        if let Some(parent) = self.file_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        let body = serde_json::to_string_pretty(state)?;
        fs::write(&self.file_path, body)
            .with_context(|| format!("failed to write {}", self.file_path.display()))?;

        Ok(())
    }

    fn build_task(
        title: &str,
        import_type: Option<&str>,
        default_import_type: &str,
    ) -> Result<Task> {
        let trimmed = title.trim();

        if trimmed.is_empty() {
            return Err(anyhow!("Task title cannot be empty"));
        }

        Ok(Task {
            id: Uuid::new_v4().to_string(),
            title: trimmed.to_owned(),
            completed: false,
            created_at: Utc::now().to_rfc3339(),
            import_type: Self::normalize_import_type(import_type, default_import_type),
            codex_status: default_codex_status(),
            codex_last_run_at: None,
            codex_last_output: None,
            codex_last_error: None,
            codex_log: default_codex_log(),
            codex_workspace: None,
            codex_workspace_source: None,
        })
    }

    fn normalize_import_type(
        import_type: Option<&str>,
        default_import_type: &str,
    ) -> String {
        let Some(value) = import_type.map(str::trim) else {
            return default_import_type.to_owned();
        };

        if value.is_empty() {
            return default_import_type.to_owned();
        }

        value.to_owned()
    }

    fn sort_tasks(mut tasks: Vec<Task>) -> Vec<Task> {
        tasks.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        tasks
    }

    fn truncate_text(value: &str, max_chars: usize) -> String {
        let mut truncated = value.chars().take(max_chars).collect::<String>();

        if value.chars().count() > max_chars {
            truncated.push_str("\n...[truncated]");
        }

        truncated
    }

    fn truncate_tail(value: &str, max_chars: usize) -> String {
        let total_chars = value.chars().count();

        if total_chars <= max_chars {
            return value.to_owned();
        }

        let skipped = total_chars - max_chars;
        let tail = value.chars().skip(skipped).collect::<String>();
        format!("...[trimmed]\n{tail}")
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }
}

#[cfg(test)]
mod tests {
    use super::TaskStore;
    use std::fs;
    use std::thread;
    use std::time::Duration;
    use tempfile::tempdir;

    #[test]
    fn adds_and_lists_tasks() {
        let dir = tempdir().unwrap();
        let store = TaskStore::new(dir.path().join("tasks.json"));

        store.add("Write tests", None).unwrap();
        thread::sleep(Duration::from_millis(2));
        store.add("Ship desktop app", Some("quick-add")).unwrap();

        let tasks = store.list().unwrap();

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].title, "Ship desktop app");
        assert_eq!(tasks[1].title, "Write tests");
        assert_eq!(tasks[0].import_type, "quick-add");
        assert_eq!(tasks[0].codex_status, "idle");
        assert!(tasks[0].codex_log.is_none());
        assert!(tasks[0].codex_workspace.is_none());
    }

    #[test]
    fn completes_a_task() {
        let dir = tempdir().unwrap();
        let store = TaskStore::new(dir.path().join("tasks.json"));

        let tasks = store.add("Close release", None).unwrap();
        let task_id = tasks[0].id.clone();

        let updated = store.complete(&task_id).unwrap();

        assert!(updated[0].completed);
    }

    #[test]
    fn deletes_a_task() {
        let dir = tempdir().unwrap();
        let store = TaskStore::new(dir.path().join("tasks.json"));

        let tasks = store.add("Remove stale task", None).unwrap();
        let task_id = tasks[0].id.clone();

        let updated = store.delete(&task_id).unwrap();

        assert!(updated.is_empty());
    }

    #[test]
    fn reads_legacy_tasks_without_import_type_field() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("tasks.json");
        let store = TaskStore::new(file_path.clone());

        fs::write(
            file_path,
            r#"{
  "tasks": [
    {
      "id": "legacy-1",
      "title": "Legacy task",
      "completed": false,
      "created_at": "2026-04-07T00:00:00Z"
    }
  ]
}"#,
        )
        .unwrap();

        let tasks = store.list().unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].import_type, "quick-add");
        assert_eq!(tasks[0].codex_status, "idle");
    }

    #[test]
    fn reads_legacy_pipeline_field_into_import_type() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("tasks.json");
        let store = TaskStore::new(file_path.clone());

        fs::write(
            file_path,
            r#"{
  "tasks": [
    {
      "id": "legacy-1",
      "title": "Legacy task",
      "completed": false,
      "created_at": "2026-04-07T00:00:00Z",
      "pipeline": "json-import"
    }
  ]
}"#,
        )
        .unwrap();

        let tasks = store.list().unwrap();

        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].import_type, "json-import");
    }

    #[test]
    fn updates_codex_run_metadata() {
        let dir = tempdir().unwrap();
        let store = TaskStore::new(dir.path().join("tasks.json"));

        let tasks = store.add("Run in Codex", None).unwrap();
        let task_id = tasks[0].id.clone();

        let queued = store
            .mark_codex_queued(&task_id, Some("/tmp/workspace"), Some("matched"))
            .unwrap();
        assert_eq!(queued[0].codex_status, "queued");
        assert_eq!(queued[0].codex_workspace.as_deref(), Some("/tmp/workspace"));

        let running = store
            .mark_codex_running(&task_id, Some("/tmp/workspace"), Some("matched"))
            .unwrap();
        assert_eq!(running[0].codex_status, "running");
        assert_eq!(running[0].codex_workspace.as_deref(), Some("/tmp/workspace"));
        assert_eq!(running[0].codex_workspace_source.as_deref(), Some("matched"));

        let logged = store.append_codex_log(&task_id, "[stdout] connected\n").unwrap();
        assert_eq!(logged[0].codex_log.as_deref(), Some("[stdout] connected\n"));

        let completed = store
            .set_codex_result(&task_id, true, Some("Done"), None)
            .unwrap();

        assert_eq!(completed[0].codex_status, "succeeded");
        assert_eq!(completed[0].codex_last_output.as_deref(), Some("Done"));
        assert_eq!(completed[0].codex_log.as_deref(), Some("[stdout] connected\n"));
    }
}
