//! Attachment ingestion and context preparation for council prompts.

use std::io::Cursor;
use std::path::Path;

use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::errors::CouncilError;
use crate::storage;
use crate::types::AttachmentMetadata;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS: &[&str] = &[".txt", ".md", ".markdown", ".pdf", ".docx", ".pptx"];

pub const MAX_FILES_PER_MESSAGE: usize = 10;
pub const MAX_FILE_BYTES: usize = 15 * 1024 * 1024; // 15 MB
pub const MAX_TOTAL_BYTES: usize = 40 * 1024 * 1024; // 40 MB
pub const MAX_EXTRACTED_CHARS_PER_FILE: usize = 30_000;
pub const MAX_CONTEXT_CHARS_TOTAL: usize = 80_000;
pub const ATTACHMENT_PREVIEW_CHARS: usize = 280;
pub const ATTACHMENT_TRACE_EXCERPT_CHARS: usize = 2_400;

pub const DEFAULT_FILES_ONLY_QUERY: &str =
    "Analyze the attached files and answer the user's request.";

// ---------------------------------------------------------------------------
// Public: uploaded file descriptor (adapter-agnostic)
// ---------------------------------------------------------------------------

/// A single uploaded file to be processed. Adapters (web/Tauri) construct these
/// from their respective upload mechanisms.
pub struct UploadedFile {
    pub filename: String,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

// ---------------------------------------------------------------------------
// Public: process & build context
// ---------------------------------------------------------------------------

/// Result of processing uploaded files.
#[derive(Debug)]
pub struct ProcessedAttachments {
    /// Rich metadata for each attachment (persisted with the user message).
    pub metadata: Vec<AttachmentMetadata>,
    /// Combined document context string ready for prompt injection.
    pub file_context: String,
}

/// Process uploaded files: validate, extract text, persist, and produce context.
pub fn process_uploaded_files(
    data_dir: &Path,
    conversation_id: Uuid,
    files: &[UploadedFile],
) -> Result<ProcessedAttachments, CouncilError> {
    info!(
        conversation_id = %conversation_id,
        file_count = files.len(),
        "Processing uploaded files"
    );

    if files.is_empty() {
        return Ok(ProcessedAttachments {
            metadata: vec![],
            file_context: String::new(),
        });
    }

    if files.len() > MAX_FILES_PER_MESSAGE {
        return Err(CouncilError::Validation(format!(
            "Maximum {MAX_FILES_PER_MESSAGE} files per message."
        )));
    }

    let mut attachments: Vec<AttachmentMetadata> = Vec::new();
    let mut context_parts: Vec<String> = Vec::new();
    let mut total_bytes: usize = 0;
    let mut remaining_context_chars: isize = MAX_CONTEXT_CHARS_TOTAL as isize;

    for upload in files {
        let filename = if upload.filename.is_empty() {
            "uploaded-file"
        } else {
            &upload.filename
        };

        let extension = file_extension(filename);
        if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
            return Err(CouncilError::Validation(format!(
                "Unsupported file type for '{filename}'. Supported: txt, md, pdf, docx, pptx."
            )));
        }

        let file_size = upload.data.len();
        if file_size == 0 {
            return Err(CouncilError::Validation(format!("'{filename}' is empty.")));
        }
        if file_size > MAX_FILE_BYTES {
            return Err(CouncilError::Validation(format!(
                "'{filename}' is too large ({}). Max per-file size is {}.",
                format_size(file_size),
                format_size(MAX_FILE_BYTES),
            )));
        }

        total_bytes += file_size;
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(CouncilError::Validation(format!(
                "Total upload size is too large. Max combined size is {}.",
                format_size(MAX_TOTAL_BYTES),
            )));
        }

        let extracted_text = extract_text_for_extension(&extension, &upload.data).map_err(|e| {
            warn!(filename, error = %e, "Text extraction failed");
            CouncilError::Extraction(format!("Failed to extract text from '{filename}': {e}"))
        })?;

        let extracted_text = normalize_text(&extracted_text);
        if extracted_text.is_empty() {
            return Err(CouncilError::Validation(format!(
                "'{filename}' does not contain extractable text."
            )));
        }

        // Per-file truncation
        let mut truncated_for_file = false;
        let extracted_text = if extracted_text.len() > MAX_EXTRACTED_CHARS_PER_FILE {
            truncated_for_file = true;
            debug!(
                filename,
                chars = extracted_text.len(),
                limit = MAX_EXTRACTED_CHARS_PER_FILE,
                "Truncating file text"
            );
            &extracted_text[..MAX_EXTRACTED_CHARS_PER_FILE]
        } else {
            &extracted_text
        };

        // Total context budget truncation
        let mut truncated_for_total = false;
        let context_text = if remaining_context_chars <= 0 {
            truncated_for_total = true;
            ""
        } else if extracted_text.len() > remaining_context_chars as usize {
            truncated_for_total = true;
            &extracted_text[..remaining_context_chars as usize]
        } else {
            extracted_text
        };
        remaining_context_chars -= context_text.len() as isize;

        if !context_text.is_empty() {
            context_parts.push(format!(
                "--- START FILE: {filename} ---\n{context_text}\n--- END FILE: {filename} ---"
            ));
        }

        // Persist the raw file
        let attachment_id = Uuid::new_v4().to_string();
        storage::save_attachment_file(
            data_dir,
            conversation_id,
            &attachment_id,
            filename,
            &upload.data,
        )?;

        // Build rich metadata
        let preview = if extracted_text.len() > ATTACHMENT_PREVIEW_CHARS {
            format!("{}...", &extracted_text[..ATTACHMENT_PREVIEW_CHARS])
        } else {
            extracted_text.to_string()
        };

        attachments.push(AttachmentMetadata {
            id: attachment_id,
            filename: filename.to_string(),
            content_type: upload.content_type.clone(),
            size_bytes: file_size as u64,
            extension: Some(extension),
            text_chars: Some(extracted_text.len()),
            context_chars: Some(context_text.len()),
            truncated: Some(truncated_for_file || truncated_for_total),
            preview: Some(preview),
            trace_excerpt: Some(build_trace_excerpt(
                extracted_text,
                ATTACHMENT_TRACE_EXCERPT_CHARS,
            )),
        });
    }

    info!(
        conversation_id = %conversation_id,
        processed = attachments.len(),
        context_parts = context_parts.len(),
        "File processing complete"
    );

    Ok(ProcessedAttachments {
        metadata: attachments,
        file_context: context_parts.join("\n\n"),
    })
}

/// Build the Stage 1 query with optional shared document context.
pub fn build_stage1_query(user_query: &str, file_context: &str) -> String {
    let normalized = user_query.trim();
    let normalized = if normalized.is_empty() {
        DEFAULT_FILES_ONLY_QUERY
    } else {
        normalized
    };

    if file_context.trim().is_empty() {
        return normalized.to_string();
    }

    format!(
        "You are answering a user request with attached documents.\n\
         Use the attached document context below as source material.\n\
         If the documents do not contain enough information, state that clearly.\n\n\
         User Request:\n{normalized}\n\n\
         Attached Document Context:\n{file_context}"
    )
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

fn extract_text_for_extension(extension: &str, data: &[u8]) -> Result<String, String> {
    match extension {
        ".txt" | ".md" | ".markdown" => Ok(extract_text_txt_or_md(data)),
        ".pdf" => extract_text_pdf(data),
        ".docx" => extract_text_docx(data),
        ".pptx" => extract_text_pptx(data),
        _ => Err(format!("Unsupported file extension: {extension}")),
    }
}

fn extract_text_txt_or_md(data: &[u8]) -> String {
    String::from_utf8(data.to_vec()).unwrap_or_else(|_| String::from_utf8_lossy(data).into_owned())
}

fn extract_text_pdf(data: &[u8]) -> Result<String, String> {
    pdf_extract::extract_text_from_mem(data).map_err(|e| format!("PDF extraction failed: {e}"))
}

fn extract_text_docx(data: &[u8]) -> Result<String, String> {
    let reader = Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Invalid DOCX archive: {e}"))?;

    let mut xml = String::new();
    {
        let mut doc_file = archive
            .by_name("word/document.xml")
            .map_err(|e| format!("Missing word/document.xml: {e}"))?;
        std::io::Read::read_to_string(&mut doc_file, &mut xml)
            .map_err(|e| format!("Failed to read document.xml: {e}"))?;
    }

    Ok(extract_text_from_xml(&xml))
}

fn extract_text_pptx(data: &[u8]) -> Result<String, String> {
    let reader = Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("Invalid PPTX archive: {e}"))?;

    // Collect slide filenames sorted by number
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let name = archive.by_index(i).ok()?.name().to_string();
            if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") {
                Some(name)
            } else {
                None
            }
        })
        .collect();
    slide_names.sort_by(|a, b| {
        extract_slide_number(a)
            .unwrap_or(0)
            .cmp(&extract_slide_number(b).unwrap_or(0))
    });

    let mut parts: Vec<String> = Vec::new();
    for (index, slide_name) in slide_names.iter().enumerate() {
        let mut xml = String::new();
        {
            let mut file = archive
                .by_name(slide_name)
                .map_err(|e| format!("Failed to read {slide_name}: {e}"))?;
            std::io::Read::read_to_string(&mut file, &mut xml)
                .map_err(|e| format!("Failed to read {slide_name}: {e}"))?;
        }
        let text = extract_text_from_xml(&xml);
        if !text.is_empty() {
            parts.push(format!("[Slide {}]\n{}", index + 1, text));
        }
    }

    Ok(parts.join("\n\n"))
}

/// Extract slide number from a filename like "ppt/slides/slide3.xml".
fn extract_slide_number(name: &str) -> Option<u32> {
    let stem = name
        .trim_start_matches("ppt/slides/slide")
        .trim_end_matches(".xml");
    stem.parse().ok()
}

/// Simple XML text extractor: pulls all text content from XML, stripping tags.
/// Works for both OOXML document.xml and slide XML formats.
fn extract_text_from_xml(xml: &str) -> String {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(xml);
    let mut in_text_element = false;
    let mut parts: Vec<String> = Vec::new();
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
                let local = e.local_name();
                // <a:t> and <w:t> are text elements in OOXML
                in_text_element = local.as_ref() == b"t";
            }
            Ok(Event::Text(ref e)) if in_text_element => {
                if let Ok(text) = e.unescape() {
                    let t = text.trim().to_string();
                    if !t.is_empty() {
                        parts.push(t);
                    }
                }
            }
            Ok(Event::End(_)) => {
                in_text_element = false;
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    parts.join("\n")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn file_extension(filename: &str) -> String {
    match filename.rsplit_once('.') {
        Some((_, ext)) => format!(".{}", ext.to_lowercase()),
        None => String::new(),
    }
}

fn format_size(size_bytes: usize) -> String {
    if size_bytes < 1024 {
        format!("{size_bytes} B")
    } else if size_bytes < 1024 * 1024 {
        format!("{:.1} KB", size_bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", size_bytes as f64 / (1024.0 * 1024.0))
    }
}

pub fn normalize_text(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(|l| l.trim()).collect();
    let mut cleaned = lines.join("\n");
    while cleaned.contains("\n\n\n") {
        cleaned = cleaned.replace("\n\n\n", "\n\n");
    }
    cleaned.trim().to_string()
}

pub fn build_trace_excerpt(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let segment = max_chars / 3;
    let middle_start = (text.len() / 2).saturating_sub(segment / 2);

    let head = text[..segment].trim();
    let middle = text[middle_start..middle_start + segment].trim();
    let tail = text[text.len() - segment..].trim();

    format!("{head}\n\n[...middle excerpt...]\n\n{middle}\n\n[...ending excerpt...]\n\n{tail}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_file_extension() {
        assert_eq!(file_extension("doc.PDF"), ".pdf");
        assert_eq!(file_extension("notes.txt"), ".txt");
        assert_eq!(file_extension("noext"), "");
        assert_eq!(file_extension("archive.tar.gz"), ".gz");
    }

    #[test]
    fn test_format_size() {
        assert_eq!(format_size(500), "500 B");
        assert_eq!(format_size(2048), "2.0 KB");
        assert_eq!(format_size(5 * 1024 * 1024), "5.0 MB");
    }

    #[test]
    fn test_normalize_text() {
        assert_eq!(
            normalize_text("  hello  \n\n\n\n  world  "),
            "hello\n\nworld"
        );
        assert_eq!(normalize_text("one\ntwo\nthree"), "one\ntwo\nthree");
    }

    #[test]
    fn test_build_trace_excerpt_short() {
        let text = "short text";
        assert_eq!(build_trace_excerpt(text, 100), "short text");
    }

    #[test]
    fn test_build_trace_excerpt_long() {
        let text = "a".repeat(3000);
        let excerpt = build_trace_excerpt(&text, 300);
        assert!(excerpt.contains("[...middle excerpt...]"));
        assert!(excerpt.contains("[...ending excerpt...]"));
        assert!(excerpt.len() < 3000);
    }

    #[test]
    fn test_extract_text_txt() {
        let data = b"Hello, world!";
        assert_eq!(extract_text_txt_or_md(data), "Hello, world!");
    }

    #[test]
    fn test_extract_text_from_xml() {
        let xml = r#"<?xml version="1.0"?>
        <w:document>
            <w:body>
                <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
                <w:p><w:r><w:t>World</w:t></w:r></w:p>
            </w:body>
        </w:document>"#;
        let text = extract_text_from_xml(xml);
        assert_eq!(text, "Hello\nWorld");
    }

    #[test]
    fn test_build_stage1_query_no_context() {
        let q = build_stage1_query("What is Rust?", "");
        assert_eq!(q, "What is Rust?");
    }

    #[test]
    fn test_build_stage1_query_with_context() {
        let q = build_stage1_query(
            "Summarize",
            "--- START FILE: doc.txt ---\nHello\n--- END FILE: doc.txt ---",
        );
        assert!(q.contains("User Request:\nSummarize"));
        assert!(q.contains("Attached Document Context:"));
        assert!(q.contains("doc.txt"));
    }

    #[test]
    fn test_build_stage1_query_empty_query_uses_default() {
        let q = build_stage1_query("", "some context");
        assert!(q.contains(DEFAULT_FILES_ONLY_QUERY));
    }

    #[test]
    fn test_process_too_many_files() {
        let tmp = TempDir::new().unwrap();
        let conv_id = Uuid::new_v4();
        storage::ensure_dirs(tmp.path()).unwrap();

        let files: Vec<UploadedFile> = (0..11)
            .map(|i| UploadedFile {
                filename: format!("file{i}.txt"),
                content_type: None,
                data: b"content".to_vec(),
            })
            .collect();

        let result = process_uploaded_files(tmp.path(), conv_id, &files);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Maximum 10 files"));
    }

    #[test]
    fn test_process_unsupported_extension() {
        let tmp = TempDir::new().unwrap();
        let conv_id = Uuid::new_v4();
        storage::ensure_dirs(tmp.path()).unwrap();

        let files = vec![UploadedFile {
            filename: "data.csv".into(),
            content_type: None,
            data: b"a,b,c".to_vec(),
        }];

        let result = process_uploaded_files(tmp.path(), conv_id, &files);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Unsupported file type"));
    }

    #[test]
    fn test_process_empty_file() {
        let tmp = TempDir::new().unwrap();
        let conv_id = Uuid::new_v4();
        storage::ensure_dirs(tmp.path()).unwrap();

        let files = vec![UploadedFile {
            filename: "empty.txt".into(),
            content_type: None,
            data: vec![],
        }];

        let result = process_uploaded_files(tmp.path(), conv_id, &files);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn test_process_txt_file_success() {
        let tmp = TempDir::new().unwrap();
        let conv_id = Uuid::new_v4();
        storage::ensure_dirs(tmp.path()).unwrap();

        let files = vec![UploadedFile {
            filename: "notes.txt".into(),
            content_type: Some("text/plain".into()),
            data: b"These are my notes about Rust.".to_vec(),
        }];

        let result = process_uploaded_files(tmp.path(), conv_id, &files).unwrap();
        assert_eq!(result.metadata.len(), 1);
        assert_eq!(result.metadata[0].filename, "notes.txt");
        assert_eq!(result.metadata[0].extension.as_deref(), Some(".txt"));
        assert_eq!(result.metadata[0].truncated, Some(false));
        assert!(result.file_context.contains("START FILE: notes.txt"));
        assert!(result
            .file_context
            .contains("These are my notes about Rust."));
    }

    #[test]
    fn test_process_truncation_per_file() {
        let tmp = TempDir::new().unwrap();
        let conv_id = Uuid::new_v4();
        storage::ensure_dirs(tmp.path()).unwrap();

        // Create file larger than MAX_EXTRACTED_CHARS_PER_FILE
        let large_content = "x".repeat(MAX_EXTRACTED_CHARS_PER_FILE + 1000);
        let files = vec![UploadedFile {
            filename: "big.txt".into(),
            content_type: None,
            data: large_content.into_bytes(),
        }];

        let result = process_uploaded_files(tmp.path(), conv_id, &files).unwrap();
        assert_eq!(result.metadata[0].truncated, Some(true));
        assert_eq!(
            result.metadata[0].text_chars,
            Some(MAX_EXTRACTED_CHARS_PER_FILE)
        );
    }

    #[test]
    fn test_process_multiple_files_context_budget() {
        let tmp = TempDir::new().unwrap();
        let conv_id = Uuid::new_v4();
        storage::ensure_dirs(tmp.path()).unwrap();

        // Two files that together exceed MAX_CONTEXT_CHARS_TOTAL
        let half_plus = "y".repeat(MAX_CONTEXT_CHARS_TOTAL / 2 + 10_000);
        let files = vec![
            UploadedFile {
                filename: "a.txt".into(),
                content_type: None,
                data: half_plus.clone().into_bytes(),
            },
            UploadedFile {
                filename: "b.txt".into(),
                content_type: None,
                data: half_plus.into_bytes(),
            },
        ];

        let result = process_uploaded_files(tmp.path(), conv_id, &files).unwrap();
        assert_eq!(result.metadata.len(), 2);
        // Second file should be truncated for total
        assert_eq!(result.metadata[1].truncated, Some(true));
        // Total context chars should not exceed budget
        let total_context: usize = result
            .metadata
            .iter()
            .map(|m| m.context_chars.unwrap_or(0))
            .sum();
        assert!(total_context <= MAX_CONTEXT_CHARS_TOTAL);
    }
}
