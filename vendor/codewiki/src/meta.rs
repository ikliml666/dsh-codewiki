use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct WikiMeta {
    pub project: String,
    pub repo_path: String,
    pub last_compiled_commit: Option<String>,
    pub last_compiled_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl WikiMeta {
    pub fn new(project: &str, repo_path: &str) -> Self {
        Self {
            project: project.to_string(),
            repo_path: repo_path.to_string(),
            last_compiled_commit: None,
            last_compiled_at: None,
            created_at: Utc::now(),
        }
    }

    pub fn load(wiki_path: &Path) -> Result<Self> {
        let meta_path = wiki_path.join("_meta.yaml");
        let content = std::fs::read_to_string(&meta_path)
            .with_context(|| format!("Failed to read {}", meta_path.display()))?;
        serde_yaml::from_str(&content).context("Failed to parse _meta.yaml")
    }

    pub fn save(&self, wiki_path: &Path) -> Result<()> {
        let meta_path = wiki_path.join("_meta.yaml");
        let content = serde_yaml::to_string(self).context("Failed to serialize meta")?;
        std::fs::write(&meta_path, content)
            .with_context(|| format!("Failed to write {}", meta_path.display()))
    }
}

/// Get current HEAD commit hash from the repo.
pub fn current_commit(repo_path: &Path) -> Result<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
        .output()
        .context("Failed to run git rev-parse")?;

    if !output.status.success() {
        anyhow::bail!("Not a git repository or no commits yet");
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
