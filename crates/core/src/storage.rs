use std::path::{Path, PathBuf};

use chrono::Utc;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::errors::CouncilError;
use crate::types::{
    AttachmentMetadata, Conversation, ConversationSummary, CouncilMetadata, FinalResult, Message,
    RankingResult, StageResult,
};

fn conversations_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("conversations")
}

fn uploads_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("uploads")
}

fn conversation_path(data_dir: &Path, id: Uuid) -> PathBuf {
    conversations_dir(data_dir).join(format!("{}.json", id))
}

/// Ensure required subdirectories exist.
pub fn ensure_dirs(data_dir: &Path) -> Result<(), CouncilError> {
    std::fs::create_dir_all(conversations_dir(data_dir))?;
    std::fs::create_dir_all(uploads_dir(data_dir))?;
    debug!(data_dir = %data_dir.display(), "Storage directories ensured");
    Ok(())
}

/// Create a new empty conversation.
pub fn create_conversation(data_dir: &Path) -> Result<Conversation, CouncilError> {
    ensure_dirs(data_dir)?;
    let conversation = Conversation {
        id: Uuid::new_v4(),
        created_at: Utc::now(),
        title: None,
        messages: Vec::new(),
    };
    save_conversation(data_dir, &conversation)?;
    info!(conversation_id = %conversation.id, "Created conversation");
    Ok(conversation)
}

/// Get a conversation by ID, returning None if it doesn't exist.
pub fn get_conversation(data_dir: &Path, id: Uuid) -> Result<Option<Conversation>, CouncilError> {
    let path = conversation_path(data_dir, id);
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)?;
    let conversation: Conversation = serde_json::from_str(&contents)?;
    Ok(Some(conversation))
}

/// List all conversations as lightweight summaries, sorted by creation time (newest first).
pub fn list_conversations(data_dir: &Path) -> Result<Vec<ConversationSummary>, CouncilError> {
    let dir = conversations_dir(data_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut summaries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let contents = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                warn!(path = %path.display(), error = %e, "Skipping unreadable conversation file");
                continue;
            }
        };
        let conv: Conversation = match serde_json::from_str(&contents) {
            Ok(c) => c,
            Err(e) => {
                warn!(path = %path.display(), error = %e, "Skipping malformed conversation file");
                continue;
            }
        };
        summaries.push(ConversationSummary {
            id: conv.id,
            created_at: conv.created_at,
            title: conv.title.unwrap_or_else(|| "New Conversation".to_string()),
            message_count: conv.messages.len(),
        });
    }

    summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(summaries)
}

/// Save a conversation to disk.
pub fn save_conversation(data_dir: &Path, conversation: &Conversation) -> Result<(), CouncilError> {
    ensure_dirs(data_dir)?;
    let path = conversation_path(data_dir, conversation.id);
    let json = serde_json::to_string_pretty(conversation)?;
    std::fs::write(&path, json)?;
    debug!(conversation_id = %conversation.id, "Saved conversation");
    Ok(())
}

/// Delete a conversation. Returns true if it existed, false otherwise.
pub fn delete_conversation(data_dir: &Path, id: Uuid) -> Result<bool, CouncilError> {
    let path = conversation_path(data_dir, id);
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(&path)?;

    // Also remove uploads directory for this conversation if it exists.
    let upload_dir = uploads_dir(data_dir).join(id.to_string());
    if upload_dir.exists() {
        std::fs::remove_dir_all(&upload_dir)?;
    }

    info!(conversation_id = %id, "Deleted conversation");
    Ok(true)
}

/// Update a conversation's title.
pub fn update_conversation_title(
    data_dir: &Path,
    id: Uuid,
    title: &str,
) -> Result<(), CouncilError> {
    let mut conv = get_conversation(data_dir, id)?
        .ok_or_else(|| CouncilError::NotFound(format!("Conversation {id} not found")))?;
    conv.title = Some(title.to_string());
    save_conversation(data_dir, &conv)?;
    debug!(conversation_id = %id, title, "Updated conversation title");
    Ok(())
}

/// Add a user message to a conversation.
pub fn add_user_message(
    data_dir: &Path,
    id: Uuid,
    content: &str,
    attachments: Vec<AttachmentMetadata>,
) -> Result<(), CouncilError> {
    let mut conv = get_conversation(data_dir, id)?
        .ok_or_else(|| CouncilError::NotFound(format!("Conversation {id} not found")))?;
    let attachment_count = attachments.len();
    conv.messages.push(Message::User {
        content: content.to_string(),
        attachments,
    });
    save_conversation(data_dir, &conv)?;
    debug!(conversation_id = %id, attachment_count, "Added user message");
    Ok(())
}

/// Add an assistant message (council response) to a conversation.
pub fn add_assistant_message(
    data_dir: &Path,
    id: Uuid,
    stage1: Option<Vec<StageResult>>,
    stage2: Option<Vec<RankingResult>>,
    stage3: Option<FinalResult>,
    metadata: Option<CouncilMetadata>,
) -> Result<(), CouncilError> {
    let mut conv = get_conversation(data_dir, id)?
        .ok_or_else(|| CouncilError::NotFound(format!("Conversation {id} not found")))?;
    conv.messages.push(Message::Assistant {
        stage1,
        stage2,
        stage3,
        metadata,
    });
    save_conversation(data_dir, &conv)?;
    debug!(conversation_id = %id, "Added assistant message");
    Ok(())
}

/// Sanitize a filename for safe filesystem storage.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Save an attachment file to disk.
pub fn save_attachment_file(
    data_dir: &Path,
    conversation_id: Uuid,
    attachment_id: &str,
    filename: &str,
    content: &[u8],
) -> Result<PathBuf, CouncilError> {
    let dir = uploads_dir(data_dir).join(conversation_id.to_string());
    std::fs::create_dir_all(&dir)?;
    let safe_name = sanitize_filename(filename);
    let file_path = dir.join(format!("{}_{}", attachment_id, safe_name));
    std::fs::write(&file_path, content)?;
    debug!(conversation_id = %conversation_id, filename, size = content.len(), "Saved attachment file");
    Ok(file_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_create_and_get_conversation() {
        let tmp = TempDir::new().unwrap();
        let conv = create_conversation(tmp.path()).unwrap();
        assert!(conv.messages.is_empty());

        let loaded = get_conversation(tmp.path(), conv.id).unwrap().unwrap();
        assert_eq!(loaded.id, conv.id);
    }

    #[test]
    fn test_get_nonexistent_returns_none() {
        let tmp = TempDir::new().unwrap();
        let result = get_conversation(tmp.path(), Uuid::new_v4()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_list_conversations() {
        let tmp = TempDir::new().unwrap();
        create_conversation(tmp.path()).unwrap();
        create_conversation(tmp.path()).unwrap();

        let list = list_conversations(tmp.path()).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn test_delete_conversation() {
        let tmp = TempDir::new().unwrap();
        let conv = create_conversation(tmp.path()).unwrap();

        assert!(delete_conversation(tmp.path(), conv.id).unwrap());
        assert!(!delete_conversation(tmp.path(), conv.id).unwrap());
        assert!(get_conversation(tmp.path(), conv.id).unwrap().is_none());
    }

    #[test]
    fn test_update_title() {
        let tmp = TempDir::new().unwrap();
        let conv = create_conversation(tmp.path()).unwrap();

        update_conversation_title(tmp.path(), conv.id, "My Title").unwrap();
        let loaded = get_conversation(tmp.path(), conv.id).unwrap().unwrap();
        assert_eq!(loaded.title, Some("My Title".to_string()));
    }

    #[test]
    fn test_add_user_message() {
        let tmp = TempDir::new().unwrap();
        let conv = create_conversation(tmp.path()).unwrap();

        add_user_message(tmp.path(), conv.id, "Hello council", vec![]).unwrap();
        let loaded = get_conversation(tmp.path(), conv.id).unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);
        match &loaded.messages[0] {
            Message::User { content, .. } => assert_eq!(content, "Hello council"),
            _ => panic!("Expected user message"),
        }
    }

    #[test]
    fn test_add_assistant_message() {
        let tmp = TempDir::new().unwrap();
        let conv = create_conversation(tmp.path()).unwrap();

        let stage1 = vec![StageResult {
            model: "openai/gpt-5.1".into(),
            response: "Test response".into(),
            reasoning_details: None,
            latency_seconds: Some(1.23),
            usage: None,
        }];
        add_assistant_message(tmp.path(), conv.id, Some(stage1), None, None, None).unwrap();

        let loaded = get_conversation(tmp.path(), conv.id).unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 1);
        match &loaded.messages[0] {
            Message::Assistant { stage1, .. } => {
                let results = stage1.as_ref().unwrap();
                assert_eq!(results[0].model, "openai/gpt-5.1");
                assert_eq!(results[0].latency_seconds, Some(1.23));
            }
            _ => panic!("Expected assistant message"),
        }
    }

    #[test]
    fn test_save_attachment_file() {
        let tmp = TempDir::new().unwrap();
        let conv = create_conversation(tmp.path()).unwrap();

        let path =
            save_attachment_file(tmp.path(), conv.id, "att-1", "my file.txt", b"hello world")
                .unwrap();

        assert!(path.exists());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello world");
        // Filename should be sanitized
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("att-1_"));
        assert!(name.contains("my_file.txt"));
    }

    #[test]
    fn test_roundtrip_python_compatible_json() {
        // Verify we can deserialize JSON in the same format Python produces
        let json = r#"{
            "id": "550e8400-e29b-41d4-a716-446655440000",
            "created_at": "2025-01-15T10:30:00Z",
            "title": "Test conversation",
            "messages": [
                {
                    "role": "user",
                    "content": "What is Rust?"
                },
                {
                    "role": "assistant",
                    "stage1": [
                        {
                            "model": "openai/gpt-5.1",
                            "response": "Rust is a systems programming language.",
                            "latency_seconds": 2.45,
                            "usage": {
                                "prompt_tokens": 100,
                                "completion_tokens": 50,
                                "total_tokens": 150
                            }
                        }
                    ],
                    "stage2": [
                        {
                            "model": "openai/gpt-5.1",
                            "ranking": "FINAL RANKING:\n1. Response A\n2. Response B",
                            "parsed_ranking": ["Response A", "Response B"],
                            "latency_seconds": 1.8
                        }
                    ],
                    "stage3": {
                        "model": "google/gemini-3-pro-preview",
                        "response": "Synthesized answer here.",
                        "latency_seconds": 3.1
                    },
                    "metadata": {
                        "label_to_model": {
                            "Response A": "openai/gpt-5.1",
                            "Response B": "anthropic/claude-sonnet-4.5"
                        },
                        "aggregate_rankings": [
                            {
                                "model": "openai/gpt-5.1",
                                "average_rank": 1.5,
                                "rankings_count": 4
                            }
                        ],
                        "failed_models": [],
                        "timing": {
                            "stage1": 2.45,
                            "stage2": 1.8,
                            "stage3": 3.1
                        }
                    }
                }
            ]
        }"#;

        let conv: Conversation = serde_json::from_str(json).unwrap();
        assert_eq!(conv.title, Some("Test conversation".to_string()));
        assert_eq!(conv.messages.len(), 2);

        // Re-serialize and deserialize to verify roundtrip
        let re_json = serde_json::to_string_pretty(&conv).unwrap();
        let conv2: Conversation = serde_json::from_str(&re_json).unwrap();
        assert_eq!(conv2.messages.len(), 2);
    }
}
