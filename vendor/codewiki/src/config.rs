use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Base directory for all wikis: ~/.codewiki/
pub fn wiki_home() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Could not determine home directory")?;
    Ok(home.join(".codewiki"))
}

/// Derive project name from git remote origin URL, falling back to directory name.
pub fn project_name(repo_path: &Path) -> Result<String> {
    let output = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo_path)
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(name) = url.rsplit('/').next() {
                let name = name.trim_end_matches(".git");
                if !name.is_empty() {
                    return Ok(name.to_string());
                }
            }
        }
    }

    repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .context("Could not determine project name from directory")
}

/// Full path to this project's wiki: ~/.codewiki/<project>/
pub fn wiki_path(repo_path: &Path) -> Result<PathBuf> {
    let name = project_name(repo_path)?;
    Ok(wiki_home()?.join(name))
}
