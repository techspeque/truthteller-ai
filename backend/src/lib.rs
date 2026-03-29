use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, OnceLock};

use reqwest::Client;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tracing::info;
#[cfg(target_os = "macos")]
use tracing::warn;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use uuid::Uuid;

use t2ai_core::attachments::{
    build_stage1_query, process_uploaded_files, UploadedFile, DEFAULT_FILES_ONLY_QUERY,
};
use t2ai_core::config;
use t2ai_core::council::{
    calculate_aggregate_rankings, generate_conversation_title_with_config, run_full_council,
    stage1_collect_responses_with_config, stage2_collect_rankings_with_config,
    stage3_synthesize_final_with_config,
};
use t2ai_core::openrouter;
use t2ai_core::storage;
use t2ai_core::types::{
    AppConfig, AppConfigResponse, Conversation, ConversationSummary, CouncilMetadata, Message,
    StageTiming,
};

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

struct TauriState {
    data_dir: PathBuf,
    api_key: String,
    http_client: Client,
}

static LOG_GUARD: OnceLock<WorkerGuard> = OnceLock::new();

fn load_openrouter_api_key() -> String {
    if let Ok(value) = std::env::var("OPENROUTER_API_KEY") {
        if !value.trim().is_empty() {
            return value;
        }
    }

    if let Ok(contents) = std::fs::read_to_string(".env") {
        for line in contents.lines() {
            if let Some(val) = line.strip_prefix("OPENROUTER_API_KEY=") {
                let candidate = val.trim();
                if !candidate.is_empty() {
                    return candidate.to_string();
                }
            }
        }
    }

    String::new()
}

fn init_logging(log_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(log_dir)
        .map_err(|e| format!("Failed to create log directory {}: {e}", log_dir.display()))?;

    let file_appender = tracing_appender::rolling::daily(log_dir, "t2ai.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let _ = LOG_GUARD.set(guard);

    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(non_blocking)
                .with_ansi(false),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();

    Ok(())
}

fn absolute_path_display(path: &Path) -> String {
    if path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }
    match std::env::current_dir() {
        Ok(current) => current.join(path).to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

#[cfg(target_os = "macos")]
fn dir_has_entries(path: &Path) -> bool {
    match std::fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_some(),
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn data_dir_has_user_data(data_dir: &Path) -> bool {
    data_dir.join("config.json").exists()
        || data_dir.join("secrets.json").exists()
        || dir_has_entries(&data_dir.join("conversations"))
        || dir_has_entries(&data_dir.join("uploads"))
}

#[cfg(target_os = "macos")]
fn migrate_legacy_tauri_data_if_needed(app: &AppHandle, data_dir: &Path) {
    if data_dir_has_user_data(data_dir) {
        return;
    }

    let home_dir = match app.path().home_dir() {
        Ok(path) => path,
        Err(e) => {
            warn!(error = %e, "Failed to resolve home directory for legacy migration check");
            return;
        }
    };

    let legacy_data_dir = home_dir.join("Library/Application Support/com.llm.council");
    if !legacy_data_dir.exists() {
        return;
    }

    match t2ai_core::migrate::migrate_data(&legacy_data_dir, data_dir) {
        Ok(count) => {
            info!(
                source = %legacy_data_dir.display(),
                destination = %data_dir.display(),
                conversations_copied = count,
                "Migrated legacy app data into TruthTeller AI directory"
            );
        }
        Err(e) => {
            warn!(
                source = %legacy_data_dir.display(),
                destination = %data_dir.display(),
                error = %e,
                "Failed to migrate legacy app data"
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn migrate_legacy_tauri_data_if_needed(_app: &AppHandle, _data_dir: &Path) {}

// ---------------------------------------------------------------------------
// File upload descriptor from JS
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct JsFileUpload {
    filename: String,
    content_type: Option<String>,
    data: Vec<u8>,
}

impl From<JsFileUpload> for UploadedFile {
    fn from(f: JsFileUpload) -> Self {
        UploadedFile {
            filename: f.filename,
            content_type: f.content_type,
            data: f.data,
        }
    }
}

// ---------------------------------------------------------------------------
// Rerun payload from JS
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RerunPayload {
    assistant_message_index: usize,
    #[serde(default = "default_stage")]
    stage: String,
    include_models: Option<Vec<String>>,
    chairman_model: Option<String>,
}

fn default_stage() -> String {
    "stage2".to_string()
}

// ---------------------------------------------------------------------------
// Helper: emit a t2ai-event to the frontend
// ---------------------------------------------------------------------------

fn emit_event(app: &AppHandle, payload: serde_json::Value) {
    let _ = app.emit("t2ai-event", payload);
}

fn effective_user_query(content: &str) -> String {
    let normalized = content.trim();
    if normalized.is_empty() {
        DEFAULT_FILES_ONLY_QUERY.to_string()
    } else {
        normalized.to_string()
    }
}

fn find_nearest_user_query(messages: &[Message], start_index: usize) -> Result<String, String> {
    for idx in (0..start_index).rev() {
        if let Message::User { content, .. } = &messages[idx] {
            return Ok(effective_user_query(content));
        }
    }
    Err("No matching user message found for assistant message".into())
}

fn resolve_active_api_key(state: &TauriState) -> Result<String, String> {
    let resolved = config::resolve_openrouter_api_key(&state.data_dir, &state.api_key);
    resolved.key.ok_or_else(|| {
        "OpenRouter API key not configured. Set OPENROUTER_API_KEY or add one in Settings."
            .to_string()
    })
}

fn open_folder(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(path);
        c
    };

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(path);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        c
    };

    let status = cmd
        .status()
        .map_err(|e| format!("Failed to open folder '{}': {e}", path.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Open command exited with status {}",
            status.code().unwrap_or(-1)
        ))
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn health_check() -> serde_json::Value {
    serde_json::json!({
        "status": "ok",
        "service": "TruthTeller AI (Tauri)"
    })
}

#[tauri::command]
fn list_conversations(
    state: State<'_, Arc<TauriState>>,
) -> Result<Vec<ConversationSummary>, String> {
    storage::list_conversations(&state.data_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_conversation(state: State<'_, Arc<TauriState>>) -> Result<Conversation, String> {
    storage::create_conversation(&state.data_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_conversation(
    state: State<'_, Arc<TauriState>>,
    conversation_id: String,
) -> Result<Conversation, String> {
    let id: Uuid = conversation_id
        .parse()
        .map_err(|e| format!("Invalid UUID: {e}"))?;
    storage::get_conversation(&state.data_dir, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Conversation not found".into())
}

#[tauri::command]
fn delete_conversation(
    state: State<'_, Arc<TauriState>>,
    conversation_id: String,
) -> Result<serde_json::Value, String> {
    let id: Uuid = conversation_id
        .parse()
        .map_err(|e| format!("Invalid UUID: {e}"))?;
    let deleted = storage::delete_conversation(&state.data_dir, id).map_err(|e| e.to_string())?;
    if !deleted {
        return Err("Conversation not found".into());
    }
    Ok(serde_json::json!({ "status": "ok" }))
}

#[tauri::command]
fn get_config(state: State<'_, Arc<TauriState>>) -> AppConfigResponse {
    config::load_config_response(&state.data_dir, &state.api_key)
}

#[tauri::command]
fn get_storage_info(state: State<'_, Arc<TauriState>>) -> serde_json::Value {
    let data_dir = state.data_dir.as_path();
    serde_json::json!({
        "runtime": "native",
        "data_dir": absolute_path_display(data_dir),
        "conversations_dir": absolute_path_display(&data_dir.join("conversations")),
        "uploads_dir": absolute_path_display(&data_dir.join("uploads")),
        "config_path": absolute_path_display(&data_dir.join("config.json")),
        "secrets_path": absolute_path_display(&data_dir.join("secrets.json")),
        "logs_dir": absolute_path_display(&data_dir.join("logs")),
        "logs_note": "Native mode writes daily rotated files named t2ai.log.YYYY-MM-DD.",
    })
}

#[tauri::command]
fn open_logs_folder(state: State<'_, Arc<TauriState>>) -> Result<serde_json::Value, String> {
    let logs_dir = state.data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| {
        format!(
            "Failed to create logs directory '{}': {e}",
            logs_dir.display()
        )
    })?;
    open_folder(&logs_dir)?;
    Ok(serde_json::json!({
        "status": "ok",
        "path": logs_dir,
    }))
}

#[tauri::command]
fn update_config(
    state: State<'_, Arc<TauriState>>,
    mut config: AppConfig,
) -> Result<AppConfigResponse, String> {
    if config.council_models.is_empty() {
        return Err("At least one council model is required".into());
    }
    if !config.council_models.contains(&config.chairman_model) {
        return Err("Chairman model must be one of the council models".into());
    }
    if !(10..=600).contains(&config.request_timeout_seconds) {
        return Err("request_timeout_seconds must be between 10 and 600".into());
    }
    if !(1..=16).contains(&config.max_parallel_requests) {
        return Err("max_parallel_requests must be between 1 and 16".into());
    }
    if config.retry_attempts > 10 {
        return Err("retry_attempts must be <= 10".into());
    }
    if config.retry_backoff_ms > 5_000 {
        return Err("retry_backoff_ms must be <= 5000".into());
    }
    if let Some(override_model) = config.stage3_model_override.as_ref() {
        if override_model.trim().is_empty() {
            config.stage3_model_override = None;
        }
    }
    t2ai_core::config::save_config(&state.data_dir, &config).map_err(|e| e.to_string())?;
    Ok(config::load_config_response(
        &state.data_dir,
        &state.api_key,
    ))
}

#[tauri::command]
fn set_openrouter_api_key(
    state: State<'_, Arc<TauriState>>,
    api_key: String,
) -> Result<AppConfigResponse, String> {
    config::set_openrouter_api_key(&state.data_dir, &api_key).map_err(|e| e.to_string())?;
    Ok(config::load_config_response(
        &state.data_dir,
        &state.api_key,
    ))
}

#[tauri::command]
fn clear_openrouter_api_key(
    state: State<'_, Arc<TauriState>>,
) -> Result<AppConfigResponse, String> {
    config::clear_openrouter_api_key(&state.data_dir).map_err(|e| e.to_string())?;
    Ok(config::load_config_response(
        &state.data_dir,
        &state.api_key,
    ))
}

#[tauri::command]
async fn test_openrouter_api_key(
    state: State<'_, Arc<TauriState>>,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    let selected_key = if let Some(key) = api_key {
        if key.trim().is_empty() {
            resolve_active_api_key(&state)?
        } else {
            key
        }
    } else {
        resolve_active_api_key(&state)?
    };

    let resp = state
        .http_client
        .get(openrouter::models_url())
        .header("Authorization", format!("Bearer {selected_key}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Failed to validate API key: {e}"))?;

    if !resp.status().is_success() {
        return Err("OpenRouter API key validation failed".into());
    }

    Ok(serde_json::json!({ "status": "ok" }))
}

#[tauri::command]
async fn get_available_models(
    state: State<'_, Arc<TauriState>>,
) -> Result<serde_json::Value, String> {
    #[derive(Deserialize)]
    struct ModelsResponse {
        data: Option<Vec<ModelEntry>>,
    }
    #[derive(Deserialize)]
    struct ModelEntry {
        id: String,
        name: Option<String>,
    }

    let api_key = resolve_active_api_key(&state)?;

    let resp = state
        .http_client
        .get(openrouter::models_url())
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {e}"))?;

    if !resp.status().is_success() {
        return Err("Failed to fetch models from OpenRouter".into());
    }

    let data: ModelsResponse = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse models response: {e}"))?;

    let mut models: Vec<serde_json::Value> = data
        .data
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let name = m.name.unwrap_or_else(|| m.id.clone());
            serde_json::json!({ "id": m.id, "name": name })
        })
        .collect();
    models.sort_by(|a, b| {
        let na = a["name"].as_str().unwrap_or("");
        let nb = b["name"].as_str().unwrap_or("");
        na.cmp(nb)
    });

    Ok(serde_json::json!(models))
}

#[tauri::command]
async fn send_message(
    state: State<'_, Arc<TauriState>>,
    conversation_id: String,
    content: String,
    files: Vec<JsFileUpload>,
) -> Result<serde_json::Value, String> {
    info!(
        conversation_id,
        file_count = files.len(),
        "Tauri: send_message"
    );
    let id: Uuid = conversation_id
        .parse()
        .map_err(|e| format!("Invalid UUID: {e}"))?;
    let conv = storage::get_conversation(&state.data_dir, id)
        .map_err(|e| e.to_string())?
        .ok_or("Conversation not found")?;

    let upload_files: Vec<UploadedFile> = files.into_iter().map(Into::into).collect();
    let processed =
        process_uploaded_files(&state.data_dir, id, &upload_files).map_err(|e| e.to_string())?;

    let is_first = conv.messages.is_empty();
    storage::add_user_message(&state.data_dir, id, &content, processed.metadata)
        .map_err(|e| e.to_string())?;

    let user_query = effective_user_query(&content);
    let stage1_query = build_stage1_query(&user_query, &processed.file_context);
    let cfg = config::load_config(&state.data_dir);
    let api_key = resolve_active_api_key(&state)?;

    if is_first {
        let title = generate_conversation_title_with_config(
            &state.http_client,
            &api_key,
            &user_query,
            &cfg,
        )
        .await;
        if let Err(e) = storage::update_conversation_title(&state.data_dir, id, &title) {
            tracing::warn!(conversation_id = %id, error = %e, "Failed to update conversation title");
        }
    }

    let stage1_q = if processed.file_context.is_empty() {
        None
    } else {
        Some(stage1_query.as_str())
    };

    let output = run_full_council(&state.http_client, &api_key, &cfg, &user_query, stage1_q)
        .await
        .map_err(|e| e.to_string())?;

    storage::add_assistant_message(
        &state.data_dir,
        id,
        Some(output.stage1.clone()),
        Some(output.stage2.clone()),
        Some(output.stage3.clone()),
        Some(output.metadata.clone()),
    )
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "stage1": output.stage1,
        "stage2": output.stage2,
        "stage3": output.stage3,
        "metadata": output.metadata,
    }))
}

#[tauri::command]
async fn send_message_stream(
    app: AppHandle,
    state: State<'_, Arc<TauriState>>,
    conversation_id: String,
    content: String,
    files: Vec<JsFileUpload>,
) -> Result<(), String> {
    info!(
        conversation_id,
        file_count = files.len(),
        "Tauri: send_message_stream"
    );
    let id: Uuid = conversation_id
        .parse()
        .map_err(|e| format!("Invalid UUID: {e}"))?;
    let conv = storage::get_conversation(&state.data_dir, id)
        .map_err(|e| e.to_string())?
        .ok_or("Conversation not found")?;

    let is_first = conv.messages.is_empty();

    // Upload processing
    emit_event(&app, serde_json::json!({"type": "upload_processing_start"}));

    let upload_files: Vec<UploadedFile> = files.into_iter().map(Into::into).collect();
    let processed = match process_uploaded_files(&state.data_dir, id, &upload_files) {
        Ok(p) => p,
        Err(e) => {
            emit_event(
                &app,
                serde_json::json!({"type": "error", "message": e.to_string()}),
            );
            return Ok(());
        }
    };

    emit_event(
        &app,
        serde_json::json!({
            "type": "upload_processing_complete",
            "attachments": processed.metadata,
        }),
    );

    if content.trim().is_empty() && upload_files.is_empty() {
        emit_event(
            &app,
            serde_json::json!({"type": "error", "message": "Provide message content or at least one file"}),
        );
        return Ok(());
    }

    let user_query = effective_user_query(&content);
    let stage1_query = build_stage1_query(&user_query, &processed.file_context);
    let cfg = config::load_config(&state.data_dir);
    let api_key = match resolve_active_api_key(&state) {
        Ok(k) => k,
        Err(e) => {
            emit_event(&app, serde_json::json!({"type": "error", "message": e}));
            return Ok(());
        }
    };

    // Save user message
    if let Err(e) = storage::add_user_message(&state.data_dir, id, &content, processed.metadata) {
        emit_event(
            &app,
            serde_json::json!({"type": "error", "message": e.to_string()}),
        );
        return Ok(());
    }

    // Title generation (background)
    let title_handle = if is_first {
        let client = state.http_client.clone();
        let api_key = api_key.clone();
        let seed = if content.trim().is_empty() {
            user_query.clone()
        } else {
            content.clone()
        };
        let cfg = cfg.clone();
        Some(tokio::spawn(async move {
            generate_conversation_title_with_config(&client, &api_key, &seed, &cfg).await
        }))
    } else {
        None
    };

    // Stage 1
    emit_event(
        &app,
        serde_json::json!({"type": "stage1_start", "models": &cfg.council_models}),
    );
    let s1 = stage1_collect_responses_with_config(
        &state.http_client,
        &api_key,
        &stage1_query,
        &cfg.council_models,
        &cfg,
    )
    .await;
    emit_event(
        &app,
        serde_json::json!({
            "type": "stage1_complete",
            "data": s1.results,
            "timing": s1.elapsed,
            "failed_models": s1.failed_models,
            "failed_model_errors": s1.failed_model_errors,
        }),
    );

    if s1.results.is_empty() {
        emit_event(
            &app,
            serde_json::json!({"type": "error", "message": "All models failed to respond."}),
        );
        return Ok(());
    }

    // Stage 2
    emit_event(
        &app,
        serde_json::json!({"type": "stage2_start", "models": &cfg.council_models}),
    );
    let (stage2_results, label_to_model, aggregate_rankings, stage2_time) = if cfg.stage2_enabled {
        let s2 = stage2_collect_rankings_with_config(
            &state.http_client,
            &api_key,
            &user_query,
            &s1.results,
            &cfg.council_models,
            &cfg,
        )
        .await;
        let aggregate_rankings = calculate_aggregate_rankings(&s2.results, &s2.label_to_model);
        let partial_metadata = CouncilMetadata {
            label_to_model: Some(s2.label_to_model.clone()),
            aggregate_rankings: aggregate_rankings.clone(),
            failed_models: s1.failed_models.clone(),
            failed_model_errors: Some(s1.failed_model_errors.clone()),
            timing: Some(StageTiming {
                stage1: Some(s1.elapsed),
                stage2: Some(s2.elapsed),
                stage3: None,
            }),
        };
        emit_event(
            &app,
            serde_json::json!({
                "type": "stage2_complete",
                "data": s2.results,
                "metadata": partial_metadata,
                "timing": s2.elapsed,
            }),
        );
        (
            s2.results,
            Some(s2.label_to_model),
            aggregate_rankings,
            Some(s2.elapsed),
        )
    } else {
        emit_event(
            &app,
            serde_json::json!({
                "type": "stage2_complete",
                "data": [],
                "metadata": {
                    "label_to_model": null,
                    "aggregate_rankings": [],
                    "failed_models": s1.failed_models.clone(),
                    "failed_model_errors": s1.failed_model_errors.clone(),
                    "timing": {
                        "stage1": s1.elapsed,
                        "stage2": null,
                        "stage3": null,
                    }
                },
                "timing": null,
            }),
        );
        (vec![], None, vec![], None)
    };

    // Stage 3
    let chairman_model = cfg
        .stage3_model_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&cfg.chairman_model);
    emit_event(
        &app,
        serde_json::json!({"type": "stage3_start", "models": [chairman_model]}),
    );

    let s3 = stage3_synthesize_final_with_config(
        &state.http_client,
        &api_key,
        &user_query,
        &s1.results,
        &stage2_results,
        chairman_model,
        &cfg,
    )
    .await;
    emit_event(
        &app,
        serde_json::json!({
            "type": "stage3_complete",
            "data": s3.result,
            "timing": s3.elapsed,
        }),
    );

    // Title
    if let Some(handle) = title_handle {
        if let Ok(title) = handle.await {
            if let Err(e) = storage::update_conversation_title(&state.data_dir, id, &title) {
                tracing::warn!(conversation_id = %id, error = %e, "Failed to update conversation title");
            }
            emit_event(
                &app,
                serde_json::json!({
                    "type": "title_complete",
                    "data": {"title": title},
                }),
            );
        }
    }

    // Final metadata
    let final_metadata = CouncilMetadata {
        label_to_model,
        aggregate_rankings,
        failed_models: s1.failed_models,
        failed_model_errors: Some(s1.failed_model_errors),
        timing: Some(StageTiming {
            stage1: Some(s1.elapsed),
            stage2: stage2_time,
            stage3: Some(s3.elapsed),
        }),
    };

    // Persist
    if let Err(e) = storage::add_assistant_message(
        &state.data_dir,
        id,
        Some(s1.results),
        Some(stage2_results),
        Some(s3.result),
        Some(final_metadata.clone()),
    ) {
        tracing::warn!(conversation_id = %id, error = %e, "Failed to persist assistant message");
    }

    emit_event(
        &app,
        serde_json::json!({
            "type": "complete",
            "metadata": final_metadata,
        }),
    );

    Ok(())
}

#[tauri::command]
async fn retry_models(
    state: State<'_, Arc<TauriState>>,
    conversation_id: String,
    models: Vec<String>,
    user_query: String,
) -> Result<serde_json::Value, String> {
    let id: Uuid = conversation_id
        .parse()
        .map_err(|e| format!("Invalid UUID: {e}"))?;
    let mut conv = storage::get_conversation(&state.data_dir, id)
        .map_err(|e| e.to_string())?
        .ok_or("Conversation not found")?;

    let last_idx = conv
        .messages
        .iter()
        .rposition(|m| matches!(m, Message::Assistant { .. }))
        .ok_or("No assistant messages to retry")?;

    let existing_stage1 = match &conv.messages[last_idx] {
        Message::Assistant { stage1, .. } => stage1.clone().unwrap_or_default(),
        _ => unreachable!(),
    };
    let api_key = resolve_active_api_key(&state)?;

    let cfg = config::load_config(&state.data_dir);
    let s1 = stage1_collect_responses_with_config(
        &state.http_client,
        &api_key,
        &user_query,
        &models,
        &cfg,
    )
    .await;

    let mut merged = existing_stage1;
    for r in s1.results {
        if let Some(pos) = merged.iter().position(|x| x.model == r.model) {
            merged[pos] = r;
        } else {
            merged.push(r);
        }
    }

    let (stage2_results, label_to_model, aggregate_rankings, stage2_time) = if cfg.stage2_enabled {
        let s2 = stage2_collect_rankings_with_config(
            &state.http_client,
            &api_key,
            &user_query,
            &merged,
            &cfg.council_models,
            &cfg,
        )
        .await;
        let aggregate_rankings = calculate_aggregate_rankings(&s2.results, &s2.label_to_model);
        (
            s2.results,
            Some(s2.label_to_model),
            aggregate_rankings,
            Some(s2.elapsed),
        )
    } else {
        (vec![], None, vec![], None)
    };

    let chairman_model = cfg
        .stage3_model_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&cfg.chairman_model);

    let s3 = stage3_synthesize_final_with_config(
        &state.http_client,
        &api_key,
        &user_query,
        &merged,
        &stage2_results,
        chairman_model,
        &cfg,
    )
    .await;

    let metadata = CouncilMetadata {
        label_to_model,
        aggregate_rankings,
        failed_models: s1.failed_models,
        failed_model_errors: Some(s1.failed_model_errors),
        timing: Some(StageTiming {
            stage1: Some(s1.elapsed),
            stage2: stage2_time,
            stage3: Some(s3.elapsed),
        }),
    };

    conv.messages[last_idx] = Message::Assistant {
        stage1: Some(merged.clone()),
        stage2: Some(stage2_results.clone()),
        stage3: Some(s3.result.clone()),
        metadata: Some(metadata.clone()),
    };
    storage::save_conversation(&state.data_dir, &conv).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "stage1": merged,
        "stage2": stage2_results,
        "stage3": s3.result,
        "metadata": metadata,
    }))
}

#[tauri::command]
async fn rerun_assistant(
    state: State<'_, Arc<TauriState>>,
    conversation_id: String,
    payload: RerunPayload,
) -> Result<serde_json::Value, String> {
    let id: Uuid = conversation_id
        .parse()
        .map_err(|e| format!("Invalid UUID: {e}"))?;
    let mut conv = storage::get_conversation(&state.data_dir, id)
        .map_err(|e| e.to_string())?
        .ok_or("Conversation not found")?;

    if payload.assistant_message_index >= conv.messages.len() {
        return Err("assistant_message_index is out of range".into());
    }

    let (stage1_results, existing_metadata) = match &conv.messages[payload.assistant_message_index]
    {
        Message::Assistant {
            stage1, metadata, ..
        } => (
            stage1.clone().unwrap_or_default(),
            metadata.clone().unwrap_or_default(),
        ),
        _ => return Err("assistant_message_index must point to an assistant message".into()),
    };

    if stage1_results.is_empty() {
        return Err("Assistant message has no Stage 1 results to rerun from".into());
    }

    let all_models: Vec<String> = stage1_results.iter().map(|r| r.model.clone()).collect();
    let all_set: HashSet<&str> = all_models.iter().map(|s| s.as_str()).collect();

    let requested = payload.include_models.as_ref().unwrap_or(&all_models);
    let selected: Vec<String> = requested
        .iter()
        .filter(|m| all_set.contains(m.as_str()))
        .cloned()
        .collect();

    if selected.is_empty() {
        return Err("No valid models selected for rerun".into());
    }

    let selected_set: HashSet<&str> = selected.iter().map(|s| s.as_str()).collect();
    let filtered: Vec<_> = stage1_results
        .into_iter()
        .filter(|r| selected_set.contains(r.model.as_str()))
        .collect();

    let user_query = find_nearest_user_query(&conv.messages, payload.assistant_message_index)?;

    let timing_stage1 = existing_metadata.timing.as_ref().and_then(|t| t.stage1);
    let api_key = resolve_active_api_key(&state)?;
    let cfg = config::load_config(&state.data_dir);

    let should_rerun_s2 =
        (payload.stage == "stage2" || payload.include_models.is_some()) && cfg.stage2_enabled;

    let (s2_results, label_to_model, agg_rankings, s2_time) = if should_rerun_s2 {
        let s2 = stage2_collect_rankings_with_config(
            &state.http_client,
            &api_key,
            &user_query,
            &filtered,
            &selected,
            &cfg,
        )
        .await;
        let agg = calculate_aggregate_rankings(&s2.results, &s2.label_to_model);
        (s2.results, Some(s2.label_to_model), agg, Some(s2.elapsed))
    } else {
        let existing_s2 = match &conv.messages[payload.assistant_message_index] {
            Message::Assistant { stage2, .. } => stage2.clone().unwrap_or_default(),
            _ => vec![],
        };
        let ltm = existing_metadata.label_to_model.clone();
        let agg = existing_metadata.aggregate_rankings.clone();
        let time = existing_metadata.timing.as_ref().and_then(|t| t.stage2);
        (existing_s2, ltm, agg, time)
    };

    let configured_chairman = cfg
        .stage3_model_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&cfg.chairman_model);
    let chairman = payload
        .chairman_model
        .as_deref()
        .unwrap_or(configured_chairman);

    let s3 = stage3_synthesize_final_with_config(
        &state.http_client,
        &api_key,
        &user_query,
        &filtered,
        &s2_results,
        chairman,
        &cfg,
    )
    .await;

    let metadata = CouncilMetadata {
        label_to_model,
        aggregate_rankings: agg_rankings,
        failed_models: vec![],
        failed_model_errors: None,
        timing: Some(StageTiming {
            stage1: timing_stage1.or(Some(0.0)),
            stage2: s2_time,
            stage3: Some(s3.elapsed),
        }),
    };

    conv.messages[payload.assistant_message_index] = Message::Assistant {
        stage1: Some(filtered),
        stage2: Some(s2_results),
        stage3: Some(s3.result),
        metadata: Some(metadata),
    };
    storage::save_conversation(&state.data_dir, &conv).map_err(|e| e.to_string())?;

    let msg = &conv.messages[payload.assistant_message_index];
    Ok(serde_json::json!({
        "assistant_message_index": payload.assistant_message_index,
        "assistant_message": msg,
    }))
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let api_key = load_openrouter_api_key();

    let http_client = openrouter::create_client().expect("Failed to create HTTP client");

    tauri::Builder::default()
        .setup(move |app| {
            // Use app-local data directory for Tauri (macOS Application Support)
            let data_dir = app
                .path()
                .app_local_data_dir()
                .unwrap_or_else(|_| PathBuf::from("data"));

            let log_dir = data_dir.join("logs");
            init_logging(&log_dir).map_err(std::io::Error::other)?;

            migrate_legacy_tauri_data_if_needed(app.handle(), &data_dir);

            storage::ensure_dirs(&data_dir).expect("Failed to create data directories");

            info!(
                log_dir = %log_dir.display(),
                "TruthTeller AI (Tauri) starting with file logging"
            );
            if api_key.trim().is_empty() {
                tracing::warn!("OPENROUTER_API_KEY not set");
            }

            let state = Arc::new(TauriState {
                data_dir,
                api_key: api_key.clone(),
                http_client: http_client.clone(),
            });

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            list_conversations,
            create_conversation,
            get_conversation,
            delete_conversation,
            get_config,
            get_storage_info,
            update_config,
            set_openrouter_api_key,
            clear_openrouter_api_key,
            test_openrouter_api_key,
            open_logs_folder,
            get_available_models,
            send_message,
            send_message_stream,
            retry_models,
            rerun_assistant,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
