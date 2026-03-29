//! API route handlers matching the Python FastAPI backend.

use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use std::path::Path as StdPath;
use tracing::{info, warn};
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
use t2ai_core::types::{CouncilMetadata, Message, StageTiming};

use crate::state::AppState;

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub(crate) struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let body = serde_json::json!({ "detail": self.1 });
        (self.0, Json(body)).into_response()
    }
}

impl From<t2ai_core::errors::CouncilError> for ApiError {
    fn from(e: t2ai_core::errors::CouncilError) -> Self {
        use t2ai_core::errors::CouncilError;
        match &e {
            CouncilError::NotFound(_) => ApiError(StatusCode::NOT_FOUND, e.to_string()),
            CouncilError::Validation(_) => ApiError(StatusCode::BAD_REQUEST, e.to_string()),
            _ => ApiError(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UpdateConfigRequest {
    council_models: Option<Vec<String>>,
    chairman_model: Option<String>,
    request_timeout_seconds: Option<u64>,
    max_parallel_requests: Option<u32>,
    retry_attempts: Option<u32>,
    retry_backoff_ms: Option<u64>,
    stage2_enabled: Option<bool>,
    stage3_model_override: Option<String>,
    theme: Option<String>,
    default_export_format: Option<String>,
    insights_expanded_default: Option<bool>,
}

#[derive(Deserialize)]
pub struct RetryRequest {
    models: Vec<String>,
    user_query: String,
}

#[derive(Deserialize)]
pub struct RerunAssistantRequest {
    assistant_message_index: usize,
    #[serde(default = "default_stage")]
    stage: String,
    include_models: Option<Vec<String>>,
    chairman_model: Option<String>,
}

fn default_stage() -> String {
    "stage2".to_string()
}

#[derive(Deserialize)]
pub struct MessagePayload {
    content: Option<String>,
}

#[derive(Deserialize)]
pub struct SetOpenRouterApiKeyRequest {
    api_key: String,
}

#[derive(Deserialize)]
pub struct TestOpenRouterApiKeyRequest {
    api_key: Option<String>,
}

// ---------------------------------------------------------------------------
// Conversations CRUD
// ---------------------------------------------------------------------------

pub async fn list_conversations(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let list = storage::list_conversations(state.data_dir())?;
    Ok(Json(list))
}

pub async fn create_conversation(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let conv = storage::create_conversation(state.data_dir())?;
    Ok((StatusCode::CREATED, Json(conv)))
}

pub async fn get_conversation(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let conv = storage::get_conversation(state.data_dir(), id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Conversation not found".into()))?;
    Ok(Json(conv))
}

pub async fn delete_conversation(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, ApiError> {
    let deleted = storage::delete_conversation(state.data_dir(), id)?;
    if !deleted {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Conversation not found".into(),
        ));
    }
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

fn absolute_path_display(path: &StdPath) -> String {
    if path.is_absolute() {
        return path.to_string_lossy().into_owned();
    }
    match std::env::current_dir() {
        Ok(current) => current.join(path).to_string_lossy().into_owned(),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

pub async fn get_storage_info(State(state): State<AppState>) -> impl IntoResponse {
    let data_dir = state.data_dir();
    Json(serde_json::json!({
        "runtime": "web",
        "data_dir": absolute_path_display(data_dir),
        "conversations_dir": absolute_path_display(&data_dir.join("conversations")),
        "uploads_dir": absolute_path_display(&data_dir.join("uploads")),
        "config_path": absolute_path_display(&data_dir.join("config.json")),
        "secrets_path": absolute_path_display(&data_dir.join("secrets.json")),
        "logs_dir": serde_json::Value::Null,
        "logs_note": "Web mode logs to process stdout/stderr by default.",
    }))
}

pub async fn get_config(State(state): State<AppState>) -> impl IntoResponse {
    let cfg = config::load_config_response(state.data_dir(), state.api_key());
    Json(cfg)
}

pub async fn update_config(
    State(state): State<AppState>,
    Json(req): Json<UpdateConfigRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let mut cfg = config::load_config(state.data_dir());
    if let Some(models) = req.council_models {
        cfg.council_models = models;
    }
    if let Some(chairman) = req.chairman_model {
        cfg.chairman_model = chairman;
    }
    if let Some(timeout) = req.request_timeout_seconds {
        cfg.request_timeout_seconds = timeout;
    }
    if let Some(parallel) = req.max_parallel_requests {
        cfg.max_parallel_requests = parallel;
    }
    if let Some(retries) = req.retry_attempts {
        cfg.retry_attempts = retries;
    }
    if let Some(backoff) = req.retry_backoff_ms {
        cfg.retry_backoff_ms = backoff;
    }
    if let Some(stage2_enabled) = req.stage2_enabled {
        cfg.stage2_enabled = stage2_enabled;
    }
    if let Some(override_model) = req.stage3_model_override {
        if override_model.trim().is_empty() {
            cfg.stage3_model_override = None;
        } else {
            cfg.stage3_model_override = Some(override_model);
        }
    }
    if let Some(theme) = req.theme {
        cfg.theme = theme;
    }
    if let Some(default_export_format) = req.default_export_format {
        cfg.default_export_format = default_export_format;
    }
    if let Some(insights_default) = req.insights_expanded_default {
        cfg.insights_expanded_default = insights_default;
    }

    if cfg.council_models.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "At least one council model is required".into(),
        ));
    }
    if !cfg.council_models.contains(&cfg.chairman_model) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Chairman model must be one of the council models".into(),
        ));
    }
    if !(10..=600).contains(&cfg.request_timeout_seconds) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "request_timeout_seconds must be between 10 and 600".into(),
        ));
    }
    if !(1..=16).contains(&cfg.max_parallel_requests) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "max_parallel_requests must be between 1 and 16".into(),
        ));
    }
    if cfg.retry_attempts > 10 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "retry_attempts must be <= 10".into(),
        ));
    }
    if cfg.retry_backoff_ms > 5_000 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "retry_backoff_ms must be <= 5000".into(),
        ));
    }
    config::save_config(state.data_dir(), &cfg)?;
    info!("Config updated via API");
    let response = config::load_config_response(state.data_dir(), state.api_key());
    Ok(Json(response))
}

pub async fn set_openrouter_api_key(
    State(state): State<AppState>,
    Json(req): Json<SetOpenRouterApiKeyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    config::set_openrouter_api_key(state.data_dir(), &req.api_key)?;
    let response = config::load_config_response(state.data_dir(), state.api_key());
    Ok(Json(response))
}

pub async fn clear_openrouter_api_key(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    config::clear_openrouter_api_key(state.data_dir())?;
    let response = config::load_config_response(state.data_dir(), state.api_key());
    Ok(Json(response))
}

pub async fn test_openrouter_api_key(
    State(state): State<AppState>,
    Json(req): Json<TestOpenRouterApiKeyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let supplied = req.api_key.unwrap_or_default();
    let api_key = if supplied.trim().is_empty() {
        resolve_active_api_key(&state)?
    } else {
        supplied
    };

    let resp = state
        .http_client()
        .get(openrouter::models_url())
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                format!("Failed to validate API key: {e}"),
            )
        })?;

    if !resp.status().is_success() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "OpenRouter API key validation failed".into(),
        ));
    }

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
// Models list (proxy to OpenRouter)
// ---------------------------------------------------------------------------

pub async fn get_available_models(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    #[derive(serde::Deserialize)]
    struct ModelsResponse {
        data: Option<Vec<ModelEntry>>,
    }
    #[derive(serde::Deserialize)]
    struct ModelEntry {
        id: String,
        name: Option<String>,
    }

    let api_key = resolve_active_api_key(&state)?;

    let resp = state
        .http_client()
        .get(openrouter::models_url())
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            ApiError(
                StatusCode::BAD_GATEWAY,
                format!("Failed to fetch models: {e}"),
            )
        })?;

    if !resp.status().is_success() {
        return Err(ApiError(
            StatusCode::BAD_GATEWAY,
            "Failed to fetch models from OpenRouter".into(),
        ));
    }

    let data: ModelsResponse = resp.json().await.map_err(|e| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("Failed to parse models response: {e}"),
        )
    })?;

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

    Ok(Json(models))
}

// ---------------------------------------------------------------------------
// Send message (non-streaming)
// ---------------------------------------------------------------------------

pub async fn send_message(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<MessagePayload>,
) -> Result<impl IntoResponse, ApiError> {
    let conv = storage::get_conversation(state.data_dir(), id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Conversation not found".into()))?;

    let content = payload.content.unwrap_or_default();
    if content.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Provide message content".into(),
        ));
    }

    let is_first_message = conv.messages.is_empty();
    info!(conversation_id = %id, "Sending message (non-streaming)");

    // Add user message
    storage::add_user_message(state.data_dir(), id, &content, vec![])?;

    let user_query = effective_user_query(&content);
    let cfg = config::load_config(state.data_dir());
    let api_key = resolve_active_api_key(&state)?;

    // Generate title for first message
    if is_first_message {
        let title = generate_conversation_title_with_config(
            state.http_client(),
            &api_key,
            &user_query,
            &cfg,
        )
        .await;
        if let Err(e) = storage::update_conversation_title(state.data_dir(), id, &title) {
            warn!(conversation_id = %id, error = %e, "Failed to update conversation title");
        }
    }

    // Run full council
    let output = run_full_council(state.http_client(), &api_key, &cfg, &user_query, None).await?;

    // Persist assistant message
    storage::add_assistant_message(
        state.data_dir(),
        id,
        Some(output.stage1.clone()),
        Some(output.stage2.clone()),
        Some(output.stage3.clone()),
        Some(output.metadata.clone()),
    )?;

    Ok(Json(serde_json::json!({
        "stage1": output.stage1,
        "stage2": output.stage2,
        "stage3": output.stage3,
        "metadata": output.metadata,
    })))
}

// ---------------------------------------------------------------------------
// Send message with file uploads (multipart)
// ---------------------------------------------------------------------------

pub async fn send_message_multipart(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, ApiError> {
    let conv = storage::get_conversation(state.data_dir(), id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Conversation not found".into()))?;

    let mut content = String::new();
    let mut files: Vec<UploadedFile> = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("Multipart error: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "content" {
            content = field
                .text()
                .await
                .map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("Read error: {e}")))?;
        } else if name == "files" || name == "files[]" {
            let filename = field.file_name().unwrap_or("uploaded-file").to_string();
            let content_type = field.content_type().map(|s| s.to_string());
            let data = field
                .bytes()
                .await
                .map_err(|e| ApiError(StatusCode::BAD_REQUEST, format!("Read error: {e}")))?
                .to_vec();
            files.push(UploadedFile {
                filename,
                content_type,
                data,
            });
        }
    }

    if content.trim().is_empty() && files.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Provide message content or at least one file".into(),
        ));
    }

    info!(conversation_id = %id, file_count = files.len(), "Sending message with uploads (non-streaming)");
    let processed = process_uploaded_files(state.data_dir(), id, &files)?;
    let is_first_message = conv.messages.is_empty();

    storage::add_user_message(state.data_dir(), id, &content, processed.metadata)?;

    let user_query = effective_user_query(&content);
    let stage1_query = build_stage1_query(&user_query, &processed.file_context);
    let cfg = config::load_config(state.data_dir());
    let api_key = resolve_active_api_key(&state)?;

    if is_first_message {
        let title_seed = if content.trim().is_empty() {
            &user_query
        } else {
            &content
        };
        let title = generate_conversation_title_with_config(
            state.http_client(),
            &api_key,
            title_seed,
            &cfg,
        )
        .await;
        if let Err(e) = storage::update_conversation_title(state.data_dir(), id, &title) {
            warn!(conversation_id = %id, error = %e, "Failed to update conversation title");
        }
    }

    let output = run_full_council(
        state.http_client(),
        &api_key,
        &cfg,
        &user_query,
        Some(&stage1_query),
    )
    .await?;

    storage::add_assistant_message(
        state.data_dir(),
        id,
        Some(output.stage1.clone()),
        Some(output.stage2.clone()),
        Some(output.stage3.clone()),
        Some(output.metadata.clone()),
    )?;

    Ok(Json(serde_json::json!({
        "stage1": output.stage1,
        "stage2": output.stage2,
        "stage3": output.stage3,
        "metadata": output.metadata,
    })))
}

// ---------------------------------------------------------------------------
// Retry failed models
// ---------------------------------------------------------------------------

pub async fn retry_failed_models(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<RetryRequest>,
) -> Result<impl IntoResponse, ApiError> {
    info!(conversation_id = %id, models = ?req.models, "Retrying failed models");
    let mut conv = storage::get_conversation(state.data_dir(), id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Conversation not found".into()))?;

    // Find last assistant message
    let last_assistant_idx = conv
        .messages
        .iter()
        .rposition(|m| matches!(m, Message::Assistant { .. }))
        .ok_or_else(|| {
            ApiError(
                StatusCode::BAD_REQUEST,
                "No assistant messages to retry".into(),
            )
        })?;

    let existing_stage1 = match &conv.messages[last_assistant_idx] {
        Message::Assistant { stage1, .. } => stage1.clone().unwrap_or_default(),
        _ => unreachable!(),
    };

    let cfg = config::load_config(state.data_dir());
    let api_key = resolve_active_api_key(&state)?;

    // Re-run Stage 1 for failed models only
    let s1 = stage1_collect_responses_with_config(
        state.http_client(),
        &api_key,
        &req.user_query,
        &req.models,
        &cfg,
    )
    .await;

    // Merge results
    let mut merged_stage1 = existing_stage1;
    for new_result in s1.results {
        if let Some(pos) = merged_stage1
            .iter()
            .position(|r| r.model == new_result.model)
        {
            merged_stage1[pos] = new_result;
        } else {
            merged_stage1.push(new_result);
        }
    }

    // Re-run Stage 2 and 3
    let run_stage2 = cfg.stage2_enabled;
    let (stage2_results, label_to_model, aggregate_rankings, stage2_time) = if run_stage2 {
        let s2 = stage2_collect_rankings_with_config(
            state.http_client(),
            &api_key,
            &req.user_query,
            &merged_stage1,
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

    let chairman = cfg
        .stage3_model_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&cfg.chairman_model);

    let s3 = stage3_synthesize_final_with_config(
        state.http_client(),
        &api_key,
        &req.user_query,
        &merged_stage1,
        &stage2_results,
        chairman,
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

    // Update last assistant message in storage
    conv.messages[last_assistant_idx] = Message::Assistant {
        stage1: Some(merged_stage1.clone()),
        stage2: Some(stage2_results.clone()),
        stage3: Some(s3.result.clone()),
        metadata: Some(metadata.clone()),
    };
    storage::save_conversation(state.data_dir(), &conv)?;

    Ok(Json(serde_json::json!({
        "stage1": merged_stage1,
        "stage2": stage2_results,
        "stage3": s3.result,
        "metadata": metadata,
    })))
}

// ---------------------------------------------------------------------------
// Rerun assistant stages
// ---------------------------------------------------------------------------

pub async fn rerun_assistant_stages(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(req): Json<RerunAssistantRequest>,
) -> Result<impl IntoResponse, ApiError> {
    info!(conversation_id = %id, stage = %req.stage, index = req.assistant_message_index, "Rerunning assistant stages");
    let mut conv = storage::get_conversation(state.data_dir(), id)?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Conversation not found".into()))?;

    if req.assistant_message_index >= conv.messages.len() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "assistant_message_index is out of range".into(),
        ));
    }

    let (stage1_results, existing_metadata) = match &conv.messages[req.assistant_message_index] {
        Message::Assistant {
            stage1, metadata, ..
        } => (
            stage1.clone().unwrap_or_default(),
            metadata.clone().unwrap_or_default(),
        ),
        _ => {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "assistant_message_index must point to an assistant message".into(),
            ))
        }
    };

    if stage1_results.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "Assistant message has no Stage 1 results to rerun from".into(),
        ));
    }

    let all_stage1_models: Vec<String> = stage1_results.iter().map(|r| r.model.clone()).collect();
    let all_stage1_model_set: std::collections::HashSet<&str> =
        all_stage1_models.iter().map(|s| s.as_str()).collect();

    let requested_models = req.include_models.as_ref().unwrap_or(&all_stage1_models);
    let selected_models: Vec<String> = requested_models
        .iter()
        .filter(|m| all_stage1_model_set.contains(m.as_str()))
        .cloned()
        .collect();

    if selected_models.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "No valid models selected for rerun".into(),
        ));
    }

    let selected_set: std::collections::HashSet<&str> =
        selected_models.iter().map(|s| s.as_str()).collect();
    let filtered_stage1: Vec<_> = stage1_results
        .into_iter()
        .filter(|r| selected_set.contains(r.model.as_str()))
        .collect();

    if filtered_stage1.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "No Stage 1 responses match include_models".into(),
        ));
    }

    // Find nearest user query
    let user_query = find_nearest_user_query(&conv.messages, req.assistant_message_index)?;

    let timing_stage1 = existing_metadata.timing.as_ref().and_then(|t| t.stage1);
    let api_key = resolve_active_api_key(&state)?;
    let cfg = config::load_config(state.data_dir());

    let should_rerun_stage2 =
        (req.stage == "stage2" || req.include_models.is_some()) && cfg.stage2_enabled;

    let (stage2_results, label_to_model, aggregate_rankings, stage2_time) = if should_rerun_stage2 {
        let s2 = stage2_collect_rankings_with_config(
            state.http_client(),
            &api_key,
            &user_query,
            &filtered_stage1,
            &selected_models,
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
        // Reuse existing stage2
        let existing_s2 = match &conv.messages[req.assistant_message_index] {
            Message::Assistant { stage2, .. } => stage2.clone().unwrap_or_default(),
            _ => vec![],
        };
        let existing_ltm = existing_metadata.label_to_model.clone();
        let existing_agg = existing_metadata.aggregate_rankings.clone();
        let existing_time = existing_metadata.timing.as_ref().and_then(|t| t.stage2);
        (existing_s2, existing_ltm, existing_agg, existing_time)
    };

    let configured_chairman = cfg
        .stage3_model_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&cfg.chairman_model);
    let chairman = req.chairman_model.as_deref().unwrap_or(configured_chairman);

    let s3 = stage3_synthesize_final_with_config(
        state.http_client(),
        &api_key,
        &user_query,
        &filtered_stage1,
        &stage2_results,
        chairman,
        &cfg,
    )
    .await;

    let metadata = CouncilMetadata {
        label_to_model,
        aggregate_rankings,
        failed_models: vec![],
        failed_model_errors: None,
        timing: Some(StageTiming {
            stage1: timing_stage1.or(Some(0.0)),
            stage2: stage2_time,
            stage3: Some(s3.elapsed),
        }),
    };

    conv.messages[req.assistant_message_index] = Message::Assistant {
        stage1: Some(filtered_stage1),
        stage2: Some(stage2_results),
        stage3: Some(s3.result),
        metadata: Some(metadata),
    };
    storage::save_conversation(state.data_dir(), &conv)?;

    let msg = &conv.messages[req.assistant_message_index];
    Ok(Json(serde_json::json!({
        "assistant_message_index": req.assistant_message_index,
        "assistant_message": msg,
    })))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn effective_user_query(content: &str) -> String {
    let normalized = content.trim();
    if normalized.is_empty() {
        DEFAULT_FILES_ONLY_QUERY.to_string()
    } else {
        normalized.to_string()
    }
}

fn find_nearest_user_query(messages: &[Message], start_index: usize) -> Result<String, ApiError> {
    for idx in (0..start_index).rev() {
        if let Message::User { content, .. } = &messages[idx] {
            return Ok(effective_user_query(content));
        }
    }
    Err(ApiError(
        StatusCode::BAD_REQUEST,
        "No matching user message found for assistant message".into(),
    ))
}

fn resolve_active_api_key(state: &AppState) -> Result<String, ApiError> {
    let resolved = config::resolve_openrouter_api_key(state.data_dir(), state.api_key());
    resolved.key.ok_or_else(|| {
        ApiError(
            StatusCode::BAD_REQUEST,
            "OpenRouter API key not configured. Set OPENROUTER_API_KEY or add one in Settings."
                .into(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::extract::{Path, State};
    use axum::routing::post;
    use axum::Json;
    use axum::Router;
    use std::sync::{Mutex, OnceLock};
    use uuid::Uuid;

    use crate::state::AppState;

    fn test_state(data_dir: &std::path::Path) -> AppState {
        storage::ensure_dirs(data_dir).expect("ensure dirs");
        let http_client = t2ai_core::openrouter::create_client().expect("http client");
        AppState::new(data_dir.to_path_buf(), String::new(), http_client)
    }

    fn test_data_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("t2ai-server-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    async fn mock_chat_completions() -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "choices": [{
                "message": {
                    "content": "Mock response\n\nFINAL RANKING:\n1. Response A\n2. Response B\n3. Response C\n4. Response D"
                }
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 10,
                "total_tokens": 20
            }
        }))
    }

    #[tokio::test]
    #[ignore = "requires opening a local test listener (restricted in some sandboxes)"]
    async fn set_key_then_send_message_succeeds() {
        let _env_guard = env_lock().lock().expect("env lock");
        let app = Router::new().route("/api/v1/chat/completions", post(mock_chat_completions));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock listener");
        let addr = listener.local_addr().expect("listener addr");
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        unsafe {
            std::env::set_var("OPENROUTER_BASE_URL", format!("http://{}", addr));
        }

        let data_dir = test_data_dir();
        let state = test_state(&data_dir);
        let conv = storage::create_conversation(&data_dir).expect("create conversation");

        let set_res = set_openrouter_api_key(
            State(state.clone()),
            Json(SetOpenRouterApiKeyRequest {
                api_key: "sk-or-v1-test-key".to_string(),
            }),
        )
        .await;
        assert!(set_res.is_ok(), "set key should succeed");

        let response_result = send_message(
            State(state),
            Path(conv.id),
            Json(MessagePayload {
                content: Some("What is Rust?".to_string()),
            }),
        )
        .await;
        let response = match response_result {
            Ok(resp) => resp.into_response(),
            Err(err) => panic!("send message failed: {}", err.1),
        };

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let payload: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert!(
            payload
                .get("stage1")
                .and_then(|v| v.as_array())
                .map(|v| !v.is_empty())
                .unwrap_or(false),
            "stage1 should contain model responses"
        );
        assert!(payload.get("stage3").is_some(), "stage3 should be present");

        unsafe {
            std::env::remove_var("OPENROUTER_BASE_URL");
        }
        server.abort();
        let _ = std::fs::remove_dir_all(data_dir);
    }

    #[tokio::test]
    async fn clear_key_then_send_message_fails_with_actionable_error() {
        let data_dir = test_data_dir();
        let state = test_state(&data_dir);
        let conv = storage::create_conversation(&data_dir).expect("create conversation");

        let set_res = set_openrouter_api_key(
            State(state.clone()),
            Json(SetOpenRouterApiKeyRequest {
                api_key: "sk-or-v1-test-key".to_string(),
            }),
        )
        .await;
        assert!(set_res.is_ok(), "set key should succeed");

        let clear_res = clear_openrouter_api_key(State(state.clone())).await;
        assert!(clear_res.is_ok(), "clear key should succeed");

        let result = send_message(
            State(state),
            Path(conv.id),
            Json(MessagePayload {
                content: Some("Will this fail?".to_string()),
            }),
        )
        .await;
        let err = match result {
            Ok(_) => panic!("expected missing-key error"),
            Err(err) => err,
        };

        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(
            err.1.contains("OpenRouter API key not configured"),
            "error should be actionable and mention missing API key"
        );

        let _ = std::fs::remove_dir_all(data_dir);
    }
}
