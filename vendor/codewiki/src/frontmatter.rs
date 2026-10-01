use anyhow::Result;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct ArticleFrontmatter {
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub article_type: Option<String>,
    pub source_files: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
}

/// Parse YAML frontmatter from a markdown file's content.
/// Returns None if no frontmatter found.
pub fn parse(content: &str) -> Result<Option<ArticleFrontmatter>> {
    let content = content.trim();
    if !content.starts_with("---") {
        return Ok(None);
    }

    let rest = &content[3..];
    let end = rest.find("\n---");
    match end {
        Some(pos) => {
            let yaml = &rest[..pos];
            let fm: ArticleFrontmatter = serde_yaml::from_str(yaml)?;
            Ok(Some(fm))
        }
        None => Ok(None),
    }
}
