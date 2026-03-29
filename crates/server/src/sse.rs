//! Server-Sent Events streaming for progressive stage updates.

use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use futures::stream;
use futures::StreamExt;
use tracing::{info, warn};
use uuid::Uuid;

use t2ai_core::attachments::{
    build_stage1_query, process_uploaded_files, UploadedFile, DEFAULT_FILES_ONLY_QUERY,
};
use t2ai_core::config;
use t2ai_core::council::{
    calculate_aggregate_rankings, generate_conversation_title_with_config,
    stage1_collect_responses_with_config, stage2_collect_rankings_with_config,
    stage3_synthesize_final_with_config,
};
use t2ai_core::storage;
use t2ai_core::types::{CouncilMetadata, StageTiming};

use crate::state::AppState;

fn effective_user_query(content: &str) -> String {
    let normalized = content.trim();
    if normalized.is_empty() {
        DEFAULT_FILES_ONLY_QUERY.to_string()
    } else {
        normalized.to_string()
    }
}

fn sse_event(payload: serde_json::Value) -> Event {
    Event::default().data(payload.to_string())
}

/// Streaming message endpoint — parse multipart, then yield SSE events as each
/// council stage completes.
pub async fn send_message_stream(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    info!(conversation_id = %id, "Stream: starting multipart message");

    // Verify conversation exists up front
    let conv = storage::get_conversation(state.data_dir(), id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Conversation not found".to_string()))?;
    let api_key = resolve_active_api_key(&state)?;

    let is_first_message = conv.messages.is_empty();

    // Parse multipart body eagerly (we can't do this inside the stream)
    let mut content = String::new();
    let mut files: Vec<UploadedFile> = Vec::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or("").to_string();
        if name == "content" {
            content = field.text().await.unwrap_or_default();
        } else if name == "files" || name == "files[]" {
            let filename = field.file_name().unwrap_or("uploaded-file").to_string();
            let content_type = field.content_type().map(|s| s.to_string());
            let data = field.bytes().await.map(|b| b.to_vec()).unwrap_or_default();
            files.push(UploadedFile {
                filename,
                content_type,
                data,
            });
        }
    }

    // Spawn the actual work into a stream
    let event_stream = stream::once(async move {
        let mut events: Vec<Event> = Vec::new();

        // Upload processing
        events.push(sse_event(
            serde_json::json!({"type": "upload_processing_start"}),
        ));

        let processed = match process_uploaded_files(state.data_dir(), id, &files) {
            Ok(p) => p,
            Err(e) => {
                events.push(sse_event(
                    serde_json::json!({"type": "error", "message": e.to_string()}),
                ));
                return stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
            }
        };

        events.push(sse_event(serde_json::json!({
            "type": "upload_processing_complete",
            "attachments": processed.metadata,
        })));

        if content.trim().is_empty() && files.is_empty() {
            events.push(sse_event(serde_json::json!({
                "type": "error",
                "message": "Provide message content or at least one file",
            })));
            return stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
        }

        let user_query = effective_user_query(&content);
        let stage1_query = build_stage1_query(&user_query, &processed.file_context);
        let cfg = config::load_config(state.data_dir());

        // Save user message
        if let Err(e) =
            storage::add_user_message(state.data_dir(), id, &content, processed.metadata)
        {
            events.push(sse_event(
                serde_json::json!({"type": "error", "message": e.to_string()}),
            ));
            return stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
        }

        // Kick off title generation in background
        let title_handle = if is_first_message {
            let client = state.http_client().clone();
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
        events.push(sse_event(
            serde_json::json!({"type": "stage1_start", "models": &cfg.council_models}),
        ));

        let s1 = stage1_collect_responses_with_config(
            state.http_client(),
            &api_key,
            &stage1_query,
            &cfg.council_models,
            &cfg,
        )
        .await;

        events.push(sse_event(serde_json::json!({
            "type": "stage1_complete",
            "data": s1.results,
            "timing": s1.elapsed,
            "failed_models": s1.failed_models,
            "failed_model_errors": s1.failed_model_errors,
        })));

        if s1.results.is_empty() {
            events.push(sse_event(serde_json::json!({
                "type": "error",
                "message": "All models failed to respond.",
            })));
            return stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
        }

        // Stage 2
        events.push(sse_event(
            serde_json::json!({"type": "stage2_start", "models": &cfg.council_models}),
        ));

        let (stage2_results, label_to_model, aggregate_rankings, stage2_time) = if cfg
            .stage2_enabled
        {
            let s2 = stage2_collect_rankings_with_config(
                state.http_client(),
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
            events.push(sse_event(serde_json::json!({
                "type": "stage2_complete",
                "data": s2.results,
                "metadata": partial_metadata,
                "timing": s2.elapsed,
            })));
            (
                s2.results,
                Some(s2.label_to_model),
                aggregate_rankings,
                Some(s2.elapsed),
            )
        } else {
            events.push(sse_event(serde_json::json!({
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
                        "stage3": null
                    }
                },
                "timing": null,
            })));
            (vec![], None, vec![], None)
        };

        // Stage 3
        let chairman_model = cfg
            .stage3_model_override
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&cfg.chairman_model);

        events.push(sse_event(
            serde_json::json!({"type": "stage3_start", "models": [chairman_model]}),
        ));

        let s3 = stage3_synthesize_final_with_config(
            state.http_client(),
            &api_key,
            &user_query,
            &s1.results,
            &stage2_results,
            chairman_model,
            &cfg,
        )
        .await;

        events.push(sse_event(serde_json::json!({
            "type": "stage3_complete",
            "data": s3.result,
            "timing": s3.elapsed,
        })));

        // Wait for title
        if let Some(handle) = title_handle {
            if let Ok(title) = handle.await {
                if let Err(e) = storage::update_conversation_title(state.data_dir(), id, &title) {
                    warn!(conversation_id = %id, error = %e, "Failed to update conversation title");
                }
                events.push(sse_event(serde_json::json!({
                    "type": "title_complete",
                    "data": {"title": title},
                })));
            }
        }

        // Build final metadata
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

        // Persist assistant message
        if let Err(e) = storage::add_assistant_message(
            state.data_dir(),
            id,
            Some(s1.results),
            Some(stage2_results),
            Some(s3.result),
            Some(final_metadata.clone()),
        ) {
            warn!(conversation_id = %id, error = %e, "Failed to persist assistant message");
        }

        events.push(sse_event(serde_json::json!({
            "type": "complete",
            "metadata": final_metadata,
        })));

        stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>))
    })
    .flatten();

    Ok(Sse::new(event_stream).keep_alive(KeepAlive::default()))
}

/// Streaming endpoint for JSON-only messages (no file uploads).
pub async fn send_message_stream_json(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    axum::Json(payload): axum::Json<serde_json::Value>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    info!(conversation_id = %id, "Stream: starting JSON message");

    let conv = storage::get_conversation(state.data_dir(), id)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or((StatusCode::NOT_FOUND, "Conversation not found".to_string()))?;
    let api_key = resolve_active_api_key(&state)?;

    let is_first_message = conv.messages.is_empty();
    let content = payload
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if content.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Provide message content".to_string(),
        ));
    }

    let event_stream = stream::once(async move {
        let mut events: Vec<Event> = Vec::new();

        let user_query = effective_user_query(&content);
        let cfg = config::load_config(state.data_dir());

        // Save user message
        if let Err(e) = storage::add_user_message(state.data_dir(), id, &content, vec![]) {
            events.push(sse_event(
                serde_json::json!({"type": "error", "message": e.to_string()}),
            ));
            return stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
        }

        // Title generation
        let title_handle = if is_first_message {
            let client = state.http_client().clone();
            let api_key = api_key.clone();
            let seed = content.clone();
            let cfg = cfg.clone();
            Some(tokio::spawn(async move {
                generate_conversation_title_with_config(&client, &api_key, &seed, &cfg).await
            }))
        } else {
            None
        };

        // Stage 1
        events.push(sse_event(
            serde_json::json!({"type": "stage1_start", "models": &cfg.council_models}),
        ));
        let s1 = stage1_collect_responses_with_config(
            state.http_client(),
            &api_key,
            &user_query,
            &cfg.council_models,
            &cfg,
        )
        .await;
        events.push(sse_event(serde_json::json!({
            "type": "stage1_complete",
            "data": s1.results,
            "timing": s1.elapsed,
            "failed_models": s1.failed_models,
            "failed_model_errors": s1.failed_model_errors,
        })));

        if s1.results.is_empty() {
            events.push(sse_event(serde_json::json!({
                "type": "error",
                "message": "All models failed to respond.",
            })));
            return stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>));
        }

        // Stage 2
        events.push(sse_event(
            serde_json::json!({"type": "stage2_start", "models": &cfg.council_models}),
        ));
        let (stage2_results, label_to_model, aggregate_rankings, stage2_time) = if cfg
            .stage2_enabled
        {
            let s2 = stage2_collect_rankings_with_config(
                state.http_client(),
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
            events.push(sse_event(serde_json::json!({
                "type": "stage2_complete",
                "data": s2.results,
                "metadata": partial_metadata,
                "timing": s2.elapsed,
            })));
            (
                s2.results,
                Some(s2.label_to_model),
                aggregate_rankings,
                Some(s2.elapsed),
            )
        } else {
            events.push(sse_event(serde_json::json!({
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
                        "stage3": null
                    }
                },
                "timing": null,
            })));
            (vec![], None, vec![], None)
        };

        // Stage 3
        let chairman_model = cfg
            .stage3_model_override
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&cfg.chairman_model);

        events.push(sse_event(
            serde_json::json!({"type": "stage3_start", "models": [chairman_model]}),
        ));

        let s3 = stage3_synthesize_final_with_config(
            state.http_client(),
            &api_key,
            &user_query,
            &s1.results,
            &stage2_results,
            chairman_model,
            &cfg,
        )
        .await;
        events.push(sse_event(serde_json::json!({
            "type": "stage3_complete",
            "data": s3.result,
            "timing": s3.elapsed,
        })));

        // Title
        if let Some(handle) = title_handle {
            if let Ok(title) = handle.await {
                if let Err(e) = storage::update_conversation_title(state.data_dir(), id, &title) {
                    warn!(conversation_id = %id, error = %e, "Failed to update conversation title");
                }
                events.push(sse_event(serde_json::json!({
                    "type": "title_complete",
                    "data": {"title": title},
                })));
            }
        }

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

        if let Err(e) = storage::add_assistant_message(
            state.data_dir(),
            id,
            Some(s1.results),
            Some(stage2_results),
            Some(s3.result),
            Some(final_metadata.clone()),
        ) {
            warn!(conversation_id = %id, error = %e, "Failed to persist assistant message");
        }

        events.push(sse_event(serde_json::json!({
            "type": "complete",
            "metadata": final_metadata,
        })));

        stream::iter(events.into_iter().map(Ok::<_, std::convert::Infallible>))
    })
    .flatten();

    Ok(Sse::new(event_stream).keep_alive(KeepAlive::default()))
}

fn resolve_active_api_key(state: &AppState) -> Result<String, (StatusCode, String)> {
    let resolved = config::resolve_openrouter_api_key(state.data_dir(), state.api_key());
    resolved.key.ok_or((
        StatusCode::BAD_REQUEST,
        "OpenRouter API key not configured. Set OPENROUTER_API_KEY or add one in Settings."
            .to_string(),
    ))
}
