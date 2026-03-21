use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A conversation containing messages between the user and council.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conversation {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub messages: Vec<Message>,
}

/// A message in a conversation — either from the user or the assistant (council).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role")]
#[allow(clippy::large_enum_variant)] // Messages live in Vec<Message> on the heap
pub enum Message {
    #[serde(rename = "user")]
    User {
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<AttachmentMetadata>,
    },
    #[serde(rename = "assistant")]
    Assistant {
        #[serde(skip_serializing_if = "Option::is_none")]
        stage1: Option<Vec<StageResult>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stage2: Option<Vec<RankingResult>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stage3: Option<FinalResult>,
        #[serde(skip_serializing_if = "Option::is_none")]
        metadata: Option<CouncilMetadata>,
    },
}

/// Token usage information from OpenRouter API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

/// An individual model's Stage 1 response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageResult {
    pub model: String,
    pub response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// A model's Stage 2 ranking/evaluation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankingResult {
    pub model: String,
    pub ranking: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parsed_ranking: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// The chairman's Stage 3 final synthesis.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinalResult {
    pub model: String,
    pub response: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

/// File attachment metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMetadata {
    pub id: String,
    pub filename: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_chars: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_excerpt: Option<String>,
}

/// Metadata returned alongside council results.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CouncilMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_to_model: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aggregate_rankings: Vec<AggregateRanking>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub failed_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_model_errors: Option<HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<StageTiming>,
}

/// Aggregate ranking for a single model across all peer evaluations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AggregateRanking {
    pub model: String,
    pub average_rank: f64,
    pub rankings_count: u32,
}

/// Timing information for each stage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageTiming {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage2: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage3: Option<f64>,
}

/// Persisted application configuration (no secrets).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_council_models")]
    pub council_models: Vec<String>,
    #[serde(default = "default_chairman_model")]
    pub chairman_model: String,
    #[serde(default = "default_request_timeout_seconds")]
    pub request_timeout_seconds: u64,
    #[serde(default = "default_max_parallel_requests")]
    pub max_parallel_requests: u32,
    #[serde(default = "default_retry_attempts")]
    pub retry_attempts: u32,
    #[serde(default = "default_retry_backoff_ms")]
    pub retry_backoff_ms: u64,
    #[serde(default = "default_stage2_enabled")]
    pub stage2_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage3_model_override: Option<String>,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_export_format")]
    pub default_export_format: String,
    #[serde(default = "default_insights_expanded_default")]
    pub insights_expanded_default: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            council_models: default_council_models(),
            chairman_model: default_chairman_model(),
            request_timeout_seconds: default_request_timeout_seconds(),
            max_parallel_requests: default_max_parallel_requests(),
            retry_attempts: default_retry_attempts(),
            retry_backoff_ms: default_retry_backoff_ms(),
            stage2_enabled: default_stage2_enabled(),
            stage3_model_override: None,
            theme: default_theme(),
            default_export_format: default_export_format(),
            insights_expanded_default: default_insights_expanded_default(),
        }
    }
}

/// Credential status returned to the frontend without exposing secret values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialsStatus {
    pub openrouter_configured: bool,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masked_hint: Option<String>,
}

/// API response shape for settings/config reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfigResponse {
    #[serde(flatten)]
    pub config: AppConfig,
    pub credentials: CredentialsStatus,
}

/// Lightweight summary for conversation list responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub title: String,
    pub message_count: usize,
}

fn default_council_models() -> Vec<String> {
    vec![
        "openai/gpt-5.1".to_string(),
        "google/gemini-3-pro-preview".to_string(),
        "anthropic/claude-sonnet-4.5".to_string(),
        "x-ai/grok-4".to_string(),
    ]
}

fn default_chairman_model() -> String {
    "google/gemini-3-pro-preview".to_string()
}

fn default_request_timeout_seconds() -> u64 {
    600
}

fn default_max_parallel_requests() -> u32 {
    8
}

fn default_retry_attempts() -> u32 {
    1
}

fn default_retry_backoff_ms() -> u64 {
    500
}

fn default_stage2_enabled() -> bool {
    true
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_export_format() -> String {
    "markdown".to_string()
}

fn default_insights_expanded_default() -> bool {
    false
}
