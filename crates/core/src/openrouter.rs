//! OpenRouter API client for making LLM requests.

use std::error::Error as StdError;
use std::time::Instant;

use futures::stream::{self, StreamExt};
use reqwest::header::CONTENT_TYPE;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use tracing::{debug, error, info, warn};

use crate::errors::CouncilError;
use crate::types::Usage;

const DEFAULT_OPENROUTER_BASE_URL: &str = "https://openrouter.ai";
const REQUEST_LOG_CHAR_LIMIT: usize = 4_000;
const RESPONSE_LOG_CHAR_LIMIT: usize = 4_000;
const ERROR_BODY_CHAR_LIMIT: usize = 320;

fn normalized_base_url() -> String {
    std::env::var("OPENROUTER_BASE_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_OPENROUTER_BASE_URL.to_string())
}

pub fn chat_completions_url() -> String {
    format!("{}/api/v1/chat/completions", normalized_base_url())
}

pub fn models_url() -> String {
    format!("{}/api/v1/models", normalized_base_url())
}

/// Runtime options used for OpenRouter model queries.
#[derive(Debug, Clone, Copy)]
pub struct QueryOptions {
    pub timeout_secs: u64,
    pub retry_attempts: u32,
    pub retry_backoff_ms: u64,
    pub max_parallel_requests: usize,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            timeout_secs: 600,
            retry_attempts: 1,
            retry_backoff_ms: 500,
            max_parallel_requests: 8,
        }
    }
}

/// A chat message sent to the OpenRouter API.
#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Parsed response from a single model query.
#[derive(Debug, Clone)]
pub struct ModelResponse {
    pub content: String,
    pub reasoning_details: Option<String>,
    pub latency_seconds: f64,
    pub usage: Option<Usage>,
}

/// Raw OpenRouter API response structures (for deserialization).
#[derive(Deserialize)]
struct ApiResponse {
    choices: Vec<ApiChoice>,
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct ApiChoice {
    message: ApiMessage,
}

#[derive(Deserialize)]
struct ApiMessage {
    content: Option<serde_json::Value>,
    reasoning_details: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ApiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

/// Query a single model via the OpenRouter API.
///
/// Returns `None` if the request fails (graceful degradation).
pub async fn query_model(
    client: &Client,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    timeout_secs: u64,
) -> Option<ModelResponse> {
    let options = QueryOptions {
        timeout_secs,
        ..QueryOptions::default()
    };
    query_model_with_options(client, api_key, model, messages, options).await
}

/// Query a single model with configurable timeout/retry behavior.
pub async fn query_model_with_options(
    client: &Client,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    options: QueryOptions,
) -> Option<ModelResponse> {
    query_model_with_options_detailed(client, api_key, model, messages, options)
        .await
        .ok()
}

/// Query a single model with detailed failure reason.
pub async fn query_model_with_options_detailed(
    client: &Client,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    options: QueryOptions,
) -> Result<ModelResponse, String> {
    let max_attempts = options.retry_attempts.saturating_add(1);
    let mut attempt = 0_u32;

    loop {
        attempt += 1;
        let response =
            query_model_once_detailed(client, api_key, model, messages, options.timeout_secs).await;

        match response {
            Ok(success) => return Ok(success),
            Err(err) => {
                if attempt >= max_attempts {
                    return Err(err);
                }
                warn!(
                    model,
                    attempt,
                    max_attempts,
                    error = %err,
                    "Model query failed; retrying"
                );
            }
        }

        let backoff_multiplier = u64::from(attempt);
        let delay_ms = options
            .retry_backoff_ms
            .saturating_mul(backoff_multiplier.max(1));
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
}

async fn query_model_once_detailed(
    client: &Client,
    api_key: &str,
    model: &str,
    messages: &[ChatMessage],
    timeout_secs: u64,
) -> Result<ModelResponse, String> {
    debug!(model, "Querying model");

    let payload = serde_json::json!({
        "model": model,
        "messages": messages,
    });
    let endpoint = chat_completions_url();
    let request_preview = summarize_json_value(&payload, REQUEST_LOG_CHAR_LIMIT);
    let request_chars = serialized_char_count(&payload);

    info!(
        model,
        endpoint,
        timeout_secs,
        message_count = messages.len(),
        request_chars,
        request_preview = %request_preview,
        "Sending OpenRouter request"
    );

    let start = Instant::now();

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .json(&payload)
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(e) => {
            error!(model, error = %e, "Error querying model");
            return Err(e.to_string());
        }
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let upstream_request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-")
        .to_string();
    let response_body = match response.text().await {
        Ok(body) => body,
        Err(e) => {
            let error_kind = classify_body_read_error(&e);
            let error_chain = format_error_chain(&e);
            error!(
                model,
                %status,
                content_type,
                upstream_request_id,
                error_kind,
                request_preview = %request_preview,
                error_chain = %error_chain,
                error = %e,
                "Error reading response body"
            );
            return Err(match error_kind {
                "timeout" => format!("Response body read timeout: {e}"),
                _ => format!("Response body read error: {e}"),
            });
        }
    };
    let response_chars = response_body.chars().count();
    let response_preview = summarize_text(&response_body, RESPONSE_LOG_CHAR_LIMIT);

    if !status.is_success() {
        error!(
            model,
            %status,
            content_type,
            upstream_request_id,
            response_chars,
            request_preview = %request_preview,
            response_body = %response_preview,
            "Model returned error"
        );
        return Err(format!(
            "HTTP {}: {}",
            status,
            summarize_error_body(&response_body)
        ));
    }

    let elapsed = start.elapsed().as_secs_f64();
    let elapsed = (elapsed * 100.0).round() / 100.0; // round to 2 decimals

    let data: ApiResponse = match serde_json::from_str(&response_body) {
        Ok(d) => d,
        Err(e) => {
            error!(
                model,
                %status,
                content_type,
                upstream_request_id,
                response_chars,
                request_preview = %request_preview,
                response_body = %response_preview,
                error = %e,
                "Error parsing response"
            );
            return Err(format!(
                "Response parse error: {}; body: {}",
                e,
                summarize_error_body(&response_body)
            ));
        }
    };

    info!(
        model,
        elapsed,
        %status,
        content_type,
        upstream_request_id,
        response_chars,
        "Model responded"
    );

    let message = data.choices.into_iter().next().ok_or_else(|| {
        error!(
            model,
            %status,
            content_type,
            upstream_request_id,
            response_chars,
            request_preview = %request_preview,
            response_body = %response_preview,
            "OpenRouter response contained no choices"
        );
        "OpenRouter response contained no choices".to_string()
    })?;

    Ok(ModelResponse {
        content: extract_text_field(message.message.content.as_ref()).unwrap_or_default(),
        reasoning_details: extract_text_field(message.message.reasoning_details.as_ref()),
        latency_seconds: elapsed,
        usage: data.usage.map(|u| Usage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
        }),
    })
}

/// Query multiple models in parallel, returning a map of model name to response.
///
/// Models that fail return `None` in the map (graceful degradation).
pub async fn query_models_parallel(
    client: &Client,
    api_key: &str,
    models: &[String],
    messages: &[ChatMessage],
) -> Vec<(String, Option<ModelResponse>)> {
    query_models_parallel_with_options(client, api_key, models, messages, QueryOptions::default())
        .await
}

/// Query multiple models with configurable timeout/retry/parallelism behavior.
pub async fn query_models_parallel_with_options(
    client: &Client,
    api_key: &str,
    models: &[String],
    messages: &[ChatMessage],
    options: QueryOptions,
) -> Vec<(String, Option<ModelResponse>)> {
    let max_parallel = options.max_parallel_requests.max(1);

    let mut results: Vec<(usize, String, Option<ModelResponse>)> =
        stream::iter(models.iter().cloned().enumerate().map(|(idx, model)| {
            let client = client.clone();
            let api_key = api_key.to_string();
            let messages = messages.to_vec();
            async move {
                let resp =
                    query_model_with_options(&client, &api_key, &model, &messages, options).await;
                (idx, model, resp)
            }
        }))
        .buffer_unordered(max_parallel)
        .collect()
        .await;

    results.sort_by_key(|(idx, _, _)| *idx);
    results
        .into_iter()
        .map(|(_, model, response)| (model, response))
        .collect()
}

/// Query multiple models with detailed failure reasons.
pub async fn query_models_parallel_with_options_detailed(
    client: &Client,
    api_key: &str,
    models: &[String],
    messages: &[ChatMessage],
    options: QueryOptions,
) -> Vec<(String, Result<ModelResponse, String>)> {
    let max_parallel = options.max_parallel_requests.max(1);

    let mut results: Vec<(usize, String, Result<ModelResponse, String>)> =
        stream::iter(models.iter().cloned().enumerate().map(|(idx, model)| {
            let client = client.clone();
            let api_key = api_key.to_string();
            let messages = messages.to_vec();
            async move {
                let resp = query_model_with_options_detailed(
                    &client, &api_key, &model, &messages, options,
                )
                .await;
                (idx, model, resp)
            }
        }))
        .buffer_unordered(max_parallel)
        .collect()
        .await;

    results.sort_by_key(|(idx, _, _)| *idx);
    results
        .into_iter()
        .map(|(_, model, response)| (model, response))
        .collect()
}

fn summarize_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return "empty response body".to_string();
    }
    summarize_text(trimmed, ERROR_BODY_CHAR_LIMIT)
}

fn summarize_json_value(value: &serde_json::Value, limit: usize) -> String {
    match serde_json::to_string(value) {
        Ok(serialized) => summarize_text(&serialized, limit),
        Err(_) => "<failed to serialize request payload>".to_string(),
    }
}

fn serialized_char_count(value: &serde_json::Value) -> usize {
    match serde_json::to_string(value) {
        Ok(serialized) => serialized.chars().count(),
        Err(_) => 0,
    }
}

fn summarize_text(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut chars = trimmed.chars();
    let preview: String = chars.by_ref().take(limit).collect();
    if chars.next().is_none() {
        preview
    } else {
        format!("{preview}...")
    }
}

fn extract_text_field(value: Option<&serde_json::Value>) -> Option<String> {
    let text = value.and_then(extract_text_value)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn extract_text_value(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(flag) => Some(flag.to_string()),
        serde_json::Value::Array(items) => {
            let parts: Vec<String> = items
                .iter()
                .filter_map(extract_text_value)
                .filter(|part| !part.trim().is_empty())
                .collect();
            if parts.is_empty() {
                serde_json::to_string(items).ok()
            } else {
                Some(parts.join("\n\n"))
            }
        }
        serde_json::Value::Object(map) => {
            for key in [
                "text",
                "content",
                "reasoning",
                "reasoning_details",
                "output_text",
                "value",
            ] {
                if let Some(extracted) = map.get(key).and_then(extract_text_value) {
                    return Some(extracted);
                }
            }

            serde_json::to_string(map).ok()
        }
    }
}

fn classify_body_read_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() || error_chain_indicates_timeout(error) {
        "timeout"
    } else if error.is_decode() {
        "decode"
    } else {
        "other"
    }
}

fn error_chain_indicates_timeout(error: &reqwest::Error) -> bool {
    let mut current = error.source();
    while let Some(source) = current {
        let message = source.to_string().to_ascii_lowercase();
        if message.contains("timed out")
            || message.contains("timeout")
            || message.contains("deadline has elapsed")
        {
            return true;
        }
        current = source.source();
    }
    false
}

fn format_error_chain(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut current = error.source();
    while let Some(source) = current {
        parts.push(source.to_string());
        current = source.source();
    }
    parts.join(": ")
}

/// Create a reusable HTTP client for OpenRouter requests.
pub fn create_client() -> Result<Client, CouncilError> {
    Client::builder().build().map_err(CouncilError::Request)
}

#[cfg(test)]
mod tests {
    use super::{extract_text_field, summarize_error_body, summarize_json_value, summarize_text};

    #[test]
    fn summarize_error_body_handles_empty_input() {
        assert_eq!(summarize_error_body("   "), "empty response body");
    }

    #[test]
    fn summarize_text_truncates_at_character_boundary() {
        assert_eq!(summarize_text("abcdef", 4), "abcd...");
        assert_eq!(summarize_text("abc", 4), "abc");
    }

    #[test]
    fn summarize_json_value_serializes_and_truncates() {
        let payload = serde_json::json!({
            "model": "test-model",
            "messages": [
                {"role": "user", "content": "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"}
            ]
        });

        let preview = summarize_json_value(&payload, 80);
        assert!(preview.starts_with('{'));
        assert!(preview.ends_with("..."));
        assert!(preview.len() <= 83);
    }

    #[test]
    fn extract_text_field_accepts_plain_string() {
        let value = serde_json::json!("plain text");
        assert_eq!(
            extract_text_field(Some(&value)).as_deref(),
            Some("plain text")
        );
    }

    #[test]
    fn extract_text_field_flattens_content_parts() {
        let value = serde_json::json!([
            {"type": "text", "text": "First paragraph"},
            {"type": "text", "text": "Second paragraph"}
        ]);

        assert_eq!(
            extract_text_field(Some(&value)).as_deref(),
            Some("First paragraph\n\nSecond paragraph")
        );
    }

    #[test]
    fn extract_text_field_handles_reasoning_objects() {
        let value = serde_json::json!({
            "type": "reasoning",
            "content": [
                {"type": "text", "text": "Step one"},
                {"type": "text", "text": "Step two"}
            ]
        });

        assert_eq!(
            extract_text_field(Some(&value)).as_deref(),
            Some("Step one\n\nStep two")
        );
    }
}
