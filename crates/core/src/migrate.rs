//! Migration utility: copies legacy web-mode data into another data directory
//! (e.g. the Tauri Application Support path).

use std::path::Path;

use tracing::info;

use crate::errors::CouncilError;

/// Copy all conversations and uploads from `source` to `dest`.
/// Skips files that already exist in the destination.
/// Returns the number of conversations copied.
pub fn migrate_data(source: &Path, dest: &Path) -> Result<usize, CouncilError> {
    let source_convs = source.join("conversations");
    let dest_convs = dest.join("conversations");
    let source_uploads = source.join("uploads");
    let dest_uploads = dest.join("uploads");

    std::fs::create_dir_all(&dest_convs)?;
    std::fs::create_dir_all(&dest_uploads)?;

    let mut copied = 0usize;

    // Copy conversations
    if source_convs.exists() {
        for entry in std::fs::read_dir(&source_convs)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let dest_file = dest_convs.join(entry.file_name());
            if dest_file.exists() {
                info!(file = ?entry.file_name(), "Skipping (already exists)");
                continue;
            }
            std::fs::copy(&path, &dest_file)?;
            copied += 1;
            info!(file = ?entry.file_name(), "Copied conversation");
        }
    }

    // Copy uploads
    if source_uploads.exists() {
        for entry in std::fs::read_dir(&source_uploads)? {
            let entry = entry?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dest_dir = dest_uploads.join(entry.file_name());
            if dest_dir.exists() {
                info!(dir = ?entry.file_name(), "Skipping upload dir (already exists)");
                continue;
            }
            copy_dir_recursive(&path, &dest_dir)?;
            info!(dir = ?entry.file_name(), "Copied upload directory");
        }
    }

    // Copy root-level config/secrets files if present.
    for filename in ["config.json", "secrets.json"] {
        let source_file = source.join(filename);
        let dest_file = dest.join(filename);
        if source_file.exists() && !dest_file.exists() {
            std::fs::copy(&source_file, &dest_file)?;
            info!(file = filename, "Copied root data file");
        }
    }

    Ok(copied)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), CouncilError> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_migrate_empty_source() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();
        let count = migrate_data(src.path(), dst.path()).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_migrate_conversations() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();

        // Create source conversation
        let conv_dir = src.path().join("conversations");
        std::fs::create_dir_all(&conv_dir).unwrap();
        std::fs::write(conv_dir.join("abc.json"), r#"{"id":"abc"}"#).unwrap();

        let count = migrate_data(src.path(), dst.path()).unwrap();
        assert_eq!(count, 1);
        assert!(dst.path().join("conversations/abc.json").exists());
    }

    #[test]
    fn test_migrate_skips_existing() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();

        let src_convs = src.path().join("conversations");
        let dst_convs = dst.path().join("conversations");
        std::fs::create_dir_all(&src_convs).unwrap();
        std::fs::create_dir_all(&dst_convs).unwrap();
        std::fs::write(src_convs.join("abc.json"), "source").unwrap();
        std::fs::write(dst_convs.join("abc.json"), "existing").unwrap();

        let count = migrate_data(src.path(), dst.path()).unwrap();
        assert_eq!(count, 0);
        // Existing file should not be overwritten
        assert_eq!(
            std::fs::read_to_string(dst_convs.join("abc.json")).unwrap(),
            "existing"
        );
    }

    #[test]
    fn test_migrate_copies_uploads() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();

        let upload_dir = src.path().join("uploads/conv-1");
        std::fs::create_dir_all(&upload_dir).unwrap();
        std::fs::write(upload_dir.join("file.txt"), "hello").unwrap();

        migrate_data(src.path(), dst.path()).unwrap();
        assert!(dst.path().join("uploads/conv-1/file.txt").exists());
    }

    #[test]
    fn test_migrate_copies_secrets() {
        let src = TempDir::new().unwrap();
        let dst = TempDir::new().unwrap();

        std::fs::write(
            src.path().join("secrets.json"),
            r#"{"openrouter_api_key":"sk-or-v1-test"}"#,
        )
        .unwrap();

        migrate_data(src.path(), dst.path()).unwrap();

        assert_eq!(
            std::fs::read_to_string(dst.path().join("secrets.json")).unwrap(),
            r#"{"openrouter_api_key":"sk-or-v1-test"}"#
        );
    }
}
