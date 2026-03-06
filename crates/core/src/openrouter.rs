//! OpenRouter API client for making LLM requests.

use std::time::Instant;

use futures::stream::{self, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use tracing::{debug, error, info, warn};

use crate::errors::CouncilError;
use crate::types::Usage;

const DEFAULT_OPENROUTER_BASE_URL: &str = "https://openrouter.ai";

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
            timeout_secs: 120,
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
    content: Option<String>,
    reasoning_details: Option<String>,
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

    let start = Instant::now();

    let response = client
        .post(chat_completions_url())
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

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!(model, %status, body, "Model returned error");
        return Err(format!("HTTP {}: {}", status, summarize_error_body(&body)));
    }

    let elapsed = start.elapsed().as_secs_f64();
    let elapsed = (elapsed * 100.0).round() / 100.0; // round to 2 decimals

    let data: ApiResponse = match response.json().await {
        Ok(d) => d,
        Err(e) => {
            error!(model, error = %e, "Error parsing response");
            return Err(format!("Response parse error: {e}"));
        }
    };

    info!(model, elapsed, "Model responded");

    let message = data
        .choices
        .into_iter()
        .next()
        .ok_or_else(|| "OpenRouter response contained no choices".to_string())?;

    Ok(ModelResponse {
        content: message.message.content.unwrap_or_default(),
        reasoning_details: message.message.reasoning_details,
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
    const LIMIT: usize = 320;
    if trimmed.len() <= LIMIT {
        trimmed.to_string()
    } else {
        format!("{}...", &trimmed[..LIMIT])
    }
}

/// Create a reusable HTTP client for OpenRouter requests.
pub fn create_client() -> Result<Client, CouncilError> {
    Client::builder().build().map_err(CouncilError::Request)
}
