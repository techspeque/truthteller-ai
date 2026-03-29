//! 3-stage TruthTeller AI orchestration.

use std::collections::HashMap;
use std::time::Instant;

use regex::Regex;
use reqwest::Client;
use tracing::{info, warn};

use crate::errors::CouncilError;
use crate::openrouter::{
    query_model_with_options, query_models_parallel_with_options,
    query_models_parallel_with_options_detailed, ChatMessage, ModelResponse, QueryOptions,
};
use crate::types::{
    AggregateRanking, AppConfig, CouncilMetadata, FinalResult, RankingResult, StageResult,
    StageTiming,
};

/// Result of Stage 1: individual model responses.
pub struct Stage1Output {
    pub results: Vec<StageResult>,
    pub failed_models: Vec<String>,
    pub failed_model_errors: HashMap<String, String>,
    pub elapsed: f64,
}

/// Result of Stage 2: peer rankings.
pub struct Stage2Output {
    pub results: Vec<RankingResult>,
    pub label_to_model: HashMap<String, String>,
    pub elapsed: f64,
}

/// Result of Stage 3: chairman synthesis.
pub struct Stage3Output {
    pub result: FinalResult,
    pub elapsed: f64,
}

/// Complete council output from all three stages.
pub struct CouncilOutput {
    pub stage1: Vec<StageResult>,
    pub stage2: Vec<RankingResult>,
    pub stage3: FinalResult,
    pub metadata: CouncilMetadata,
}

fn query_options_from_config(config: &AppConfig) -> QueryOptions {
    QueryOptions {
        timeout_secs: config.request_timeout_seconds,
        retry_attempts: config.retry_attempts,
        retry_backoff_ms: config.retry_backoff_ms,
        max_parallel_requests: config.max_parallel_requests as usize,
    }
}

fn preferred_stage3_model(config: &AppConfig) -> &str {
    config
        .stage3_model_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&config.chairman_model)
}

/// Stage 1: Collect individual responses from all council models.
pub async fn stage1_collect_responses(
    client: &Client,
    api_key: &str,
    user_query: &str,
    models: &[String],
) -> Stage1Output {
    let default_options = QueryOptions::default();
    stage1_collect_responses_with_options(client, api_key, user_query, models, default_options)
        .await
}

pub async fn stage1_collect_responses_with_config(
    client: &Client,
    api_key: &str,
    user_query: &str,
    models: &[String],
    config: &AppConfig,
) -> Stage1Output {
    let options = query_options_from_config(config);
    stage1_collect_responses_with_options(client, api_key, user_query, models, options).await
}

pub async fn stage1_collect_responses_with_options(
    client: &Client,
    api_key: &str,
    user_query: &str,
    models: &[String],
    options: QueryOptions,
) -> Stage1Output {
    info!(model_count = models.len(), "Stage 1: collecting responses");

    let messages = vec![ChatMessage {
        role: "user".into(),
        content: user_query.into(),
    }];

    let start = Instant::now();
    let responses =
        query_models_parallel_with_options_detailed(client, api_key, models, &messages, options)
            .await;
    let elapsed = round2(start.elapsed().as_secs_f64());

    let mut results = Vec::new();
    let mut failed_models = Vec::new();
    let mut failed_model_errors: HashMap<String, String> = HashMap::new();

    for (model, response) in responses {
        match response {
            Ok(r) => results.push(model_response_to_stage_result(&model, r)),
            Err(reason) => {
                failed_model_errors.insert(model.clone(), reason);
                failed_models.push(model);
            }
        }
    }

    if !failed_models.is_empty() {
        warn!(failed = ?failed_models, failed_model_errors = ?failed_model_errors, "Stage 1: some models failed");
    }
    info!(succeeded = results.len(), elapsed, "Stage 1: complete");

    Stage1Output {
        results,
        failed_models,
        failed_model_errors,
        elapsed,
    }
}

/// Stage 2: Each model ranks the anonymized responses.
pub async fn stage2_collect_rankings(
    client: &Client,
    api_key: &str,
    user_query: &str,
    stage1_results: &[StageResult],
    evaluator_models: &[String],
) -> Stage2Output {
    let default_options = QueryOptions::default();
    stage2_collect_rankings_with_options(
        client,
        api_key,
        user_query,
        stage1_results,
        evaluator_models,
        default_options,
    )
    .await
}

pub async fn stage2_collect_rankings_with_config(
    client: &Client,
    api_key: &str,
    user_query: &str,
    stage1_results: &[StageResult],
    evaluator_models: &[String],
    config: &AppConfig,
) -> Stage2Output {
    let options = query_options_from_config(config);
    stage2_collect_rankings_with_options(
        client,
        api_key,
        user_query,
        stage1_results,
        evaluator_models,
        options,
    )
    .await
}

pub async fn stage2_collect_rankings_with_options(
    client: &Client,
    api_key: &str,
    user_query: &str,
    stage1_results: &[StageResult],
    evaluator_models: &[String],
    options: QueryOptions,
) -> Stage2Output {
    info!(
        responses = stage1_results.len(),
        evaluators = evaluator_models.len(),
        "Stage 2: collecting rankings"
    );

    // Create anonymized labels
    let label_to_model: HashMap<String, String> = stage1_results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let label = format!("Response {}", (b'A' + i as u8) as char);
            (label, r.model.clone())
        })
        .collect();

    // Build ranking prompt
    let responses_text: String = stage1_results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let label = (b'A' + i as u8) as char;
            format!("Response {label}:\n{}", r.response)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let ranking_prompt = format!(
        r#"You are evaluating different responses to the following question:

Question: {user_query}

Here are the responses from different models (anonymized):

{responses_text}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response A provides good detail on X but misses Y...
Response B is accurate but lacks depth on Z...
Response C offers the most comprehensive answer...

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your evaluation and ranking:"#
    );

    let messages = vec![ChatMessage {
        role: "user".into(),
        content: ranking_prompt,
    }];

    let start = Instant::now();
    let responses =
        query_models_parallel_with_options(client, api_key, evaluator_models, &messages, options)
            .await;
    let elapsed = round2(start.elapsed().as_secs_f64());

    let results: Vec<RankingResult> = responses
        .into_iter()
        .filter_map(|(model, resp)| {
            let r = resp?;
            let parsed = parse_ranking_from_text(&r.content);
            Some(RankingResult {
                model,
                ranking: r.content,
                parsed_ranking: parsed,
                latency_seconds: Some(r.latency_seconds),
                usage: r.usage,
            })
        })
        .collect();

    info!(rankings = results.len(), elapsed, "Stage 2: complete");

    Stage2Output {
        results,
        label_to_model,
        elapsed,
    }
}

/// Stage 3: Chairman synthesizes final response from all context.
pub async fn stage3_synthesize_final(
    client: &Client,
    api_key: &str,
    user_query: &str,
    stage1_results: &[StageResult],
    stage2_results: &[RankingResult],
    chairman_model: &str,
) -> Stage3Output {
    let default_options = QueryOptions::default();
    stage3_synthesize_final_with_options(
        client,
        api_key,
        user_query,
        stage1_results,
        stage2_results,
        chairman_model,
        default_options,
    )
    .await
}

pub async fn stage3_synthesize_final_with_config(
    client: &Client,
    api_key: &str,
    user_query: &str,
    stage1_results: &[StageResult],
    stage2_results: &[RankingResult],
    chairman_model: &str,
    config: &AppConfig,
) -> Stage3Output {
    let options = query_options_from_config(config);
    stage3_synthesize_final_with_options(
        client,
        api_key,
        user_query,
        stage1_results,
        stage2_results,
        chairman_model,
        options,
    )
    .await
}

pub async fn stage3_synthesize_final_with_options(
    client: &Client,
    api_key: &str,
    user_query: &str,
    stage1_results: &[StageResult],
    stage2_results: &[RankingResult],
    chairman_model: &str,
    options: QueryOptions,
) -> Stage3Output {
    info!(chairman_model, "Stage 3: synthesizing final answer");
    let stage1_text: String = stage1_results
        .iter()
        .map(|r| format!("Model: {}\nResponse: {}", r.model, r.response))
        .collect::<Vec<_>>()
        .join("\n\n");

    let stage2_text: String = stage2_results
        .iter()
        .map(|r| format!("Model: {}\nRanking: {}", r.model, r.ranking))
        .collect::<Vec<_>>()
        .join("\n\n");

    let chairman_prompt = format!(
        r#"You are the chair model for TruthTeller AI. Multiple AI models have provided responses to a user's question, and then ranked each other's responses.

Original Question: {user_query}

STAGE 1 - Individual Responses:
{stage1_text}

STAGE 2 - Peer Rankings:
{stage2_text}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights
- The peer rankings and what they reveal about response quality
- Any patterns of agreement or disagreement

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:"#
    );

    let messages = vec![ChatMessage {
        role: "user".into(),
        content: chairman_prompt,
    }];

    let start = Instant::now();
    let response =
        query_model_with_options(client, api_key, chairman_model, &messages, options).await;
    let elapsed = round2(start.elapsed().as_secs_f64());

    let result = match response {
        Some(r) => FinalResult {
            model: chairman_model.to_string(),
            response: r.content,
            reasoning_details: r.reasoning_details,
            latency_seconds: Some(r.latency_seconds),
            usage: r.usage,
        },
        None => FinalResult {
            model: chairman_model.to_string(),
            response: "Error: Unable to generate final synthesis.".to_string(),
            reasoning_details: None,
            latency_seconds: Some(elapsed),
            usage: None,
        },
    };

    info!(elapsed, "Stage 3: complete");

    Stage3Output { result, elapsed }
}

/// Run the complete 3-stage council process.
pub async fn run_full_council(
    client: &Client,
    api_key: &str,
    config: &AppConfig,
    user_query: &str,
    stage1_user_query: Option<&str>,
) -> Result<CouncilOutput, CouncilError> {
    // Stage 1
    let stage1_input = stage1_user_query.unwrap_or(user_query);
    let s1 = stage1_collect_responses_with_config(
        client,
        api_key,
        stage1_input,
        &config.council_models,
        config,
    )
    .await;

    if s1.results.is_empty() {
        return Ok(CouncilOutput {
            stage1: vec![],
            stage2: vec![],
            stage3: FinalResult {
                model: "error".into(),
                response: "All models failed to respond. Please try again.".into(),
                reasoning_details: None,
                latency_seconds: None,
                usage: None,
            },
            metadata: CouncilMetadata {
                label_to_model: None,
                aggregate_rankings: vec![],
                failed_models: s1.failed_models,
                failed_model_errors: Some(s1.failed_model_errors),
                timing: None,
            },
        });
    }

    // Stage 2 (optional)
    let (stage2_results, label_to_model, aggregate_rankings, stage2_elapsed) =
        if config.stage2_enabled {
            let s2 = stage2_collect_rankings_with_config(
                client,
                api_key,
                user_query,
                &s1.results,
                &config.council_models,
                config,
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

    // Stage 3
    let s3 = stage3_synthesize_final_with_config(
        client,
        api_key,
        user_query,
        &s1.results,
        &stage2_results,
        preferred_stage3_model(config),
        config,
    )
    .await;

    let metadata = CouncilMetadata {
        label_to_model,
        aggregate_rankings,
        failed_models: s1.failed_models,
        failed_model_errors: Some(s1.failed_model_errors),
        timing: Some(StageTiming {
            stage1: Some(s1.elapsed),
            stage2: stage2_elapsed,
            stage3: Some(s3.elapsed),
        }),
    };

    Ok(CouncilOutput {
        stage1: s1.results,
        stage2: stage2_results,
        stage3: s3.result,
        metadata,
    })
}

/// Generate a short conversation title from the first user message.
pub async fn generate_conversation_title(
    client: &Client,
    api_key: &str,
    user_query: &str,
) -> String {
    generate_conversation_title_with_options(client, api_key, user_query, QueryOptions::default())
        .await
}

pub async fn generate_conversation_title_with_config(
    client: &Client,
    api_key: &str,
    user_query: &str,
    config: &AppConfig,
) -> String {
    generate_conversation_title_with_options(
        client,
        api_key,
        user_query,
        query_options_from_config(config),
    )
    .await
}

async fn generate_conversation_title_with_options(
    client: &Client,
    api_key: &str,
    user_query: &str,
    options: QueryOptions,
) -> String {
    let title_prompt = format!(
        r#"Generate a very short title (3-5 words maximum) that summarizes the following question.
The title should be concise and descriptive. Do not use quotes or punctuation in the title.

Question: {user_query}

Title:"#
    );

    let messages = vec![ChatMessage {
        role: "user".into(),
        content: title_prompt,
    }];

    // Use gemini-2.5-flash for title generation (fast and cheap)
    let response = query_model_with_options(
        client,
        api_key,
        "google/gemini-2.5-flash",
        &messages,
        options,
    )
    .await;

    match response {
        Some(r) => {
            let mut title = r.content.trim().to_string();
            // Strip surrounding quotes
            title = title.trim_matches(|c| c == '"' || c == '\'').to_string();
            // Truncate if too long
            if title.len() > 50 {
                title.truncate(47);
                title.push_str("...");
            }
            title
        }
        None => "New Conversation".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Pure functions (no API calls)
// ---------------------------------------------------------------------------

/// Parse the FINAL RANKING section from a model's evaluation text.
pub fn parse_ranking_from_text(ranking_text: &str) -> Vec<String> {
    let response_re = Regex::new(r"Response [A-Z]").unwrap();
    let numbered_re = Regex::new(r"\d+\.\s*Response [A-Z]").unwrap();

    if let Some(idx) = ranking_text.find("FINAL RANKING:") {
        let section = &ranking_text[idx + "FINAL RANKING:".len()..];

        // Try numbered list first: "1. Response C"
        let numbered: Vec<String> = numbered_re
            .find_iter(section)
            .filter_map(|m| response_re.find(m.as_str()).map(|r| r.as_str().to_string()))
            .collect();

        if !numbered.is_empty() {
            return numbered;
        }

        // Fallback: any "Response X" in order
        return response_re
            .find_iter(section)
            .map(|m| m.as_str().to_string())
            .collect();
    }

    // Last resort: any "Response X" in the full text
    response_re
        .find_iter(ranking_text)
        .map(|m| m.as_str().to_string())
        .collect()
}

/// Calculate aggregate rankings across all peer evaluations.
pub fn calculate_aggregate_rankings(
    stage2_results: &[RankingResult],
    label_to_model: &HashMap<String, String>,
) -> Vec<AggregateRanking> {
    let mut model_positions: HashMap<&str, Vec<usize>> = HashMap::new();

    for ranking in stage2_results {
        let parsed = parse_ranking_from_text(&ranking.ranking);
        for (position, label) in parsed.iter().enumerate() {
            if let Some(model) = label_to_model.get(label.as_str()) {
                model_positions
                    .entry(model.as_str())
                    .or_default()
                    .push(position + 1); // 1-indexed
            }
        }
    }

    let mut aggregate: Vec<AggregateRanking> = model_positions
        .into_iter()
        .map(|(model, positions)| {
            let avg = positions.iter().sum::<usize>() as f64 / positions.len() as f64;
            AggregateRanking {
                model: model.to_string(),
                average_rank: (avg * 100.0).round() / 100.0,
                rankings_count: positions.len() as u32,
            }
        })
        .collect();

    aggregate.sort_by(|a, b| a.average_rank.partial_cmp(&b.average_rank).unwrap());
    aggregate
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn model_response_to_stage_result(model: &str, r: ModelResponse) -> StageResult {
    StageResult {
        model: model.to_string(),
        response: r.content,
        reasoning_details: r.reasoning_details,
        latency_seconds: Some(r.latency_seconds),
        usage: r.usage,
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_ranking_numbered_list() {
        let text = r#"Response A is thorough...
Response B is concise...

FINAL RANKING:
1. Response B
2. Response A
3. Response C"#;

        let result = parse_ranking_from_text(text);
        assert_eq!(result, vec!["Response B", "Response A", "Response C"]);
    }

    #[test]
    fn test_parse_ranking_no_header_fallback() {
        let text = "I think Response C is best, then Response A, then Response B.";
        let result = parse_ranking_from_text(text);
        assert_eq!(result, vec!["Response C", "Response A", "Response B"]);
    }

    #[test]
    fn test_parse_ranking_header_unnumbered() {
        let text = r#"Evaluation...

FINAL RANKING:
Response D
Response A
Response B"#;

        let result = parse_ranking_from_text(text);
        assert_eq!(result, vec!["Response D", "Response A", "Response B"]);
    }

    #[test]
    fn test_parse_ranking_empty() {
        let result = parse_ranking_from_text("No rankings here at all.");
        assert!(result.is_empty());
    }

    #[test]
    fn test_calculate_aggregate_rankings() {
        let label_to_model: HashMap<String, String> = [
            ("Response A".into(), "model-alpha".into()),
            ("Response B".into(), "model-beta".into()),
            ("Response C".into(), "model-gamma".into()),
        ]
        .into();

        let stage2 = vec![
            RankingResult {
                model: "model-alpha".into(),
                ranking: "FINAL RANKING:\n1. Response C\n2. Response A\n3. Response B".into(),
                parsed_ranking: vec![],
                latency_seconds: None,
                usage: None,
            },
            RankingResult {
                model: "model-beta".into(),
                ranking: "FINAL RANKING:\n1. Response A\n2. Response C\n3. Response B".into(),
                parsed_ranking: vec![],
                latency_seconds: None,
                usage: None,
            },
        ];

        let agg = calculate_aggregate_rankings(&stage2, &label_to_model);

        assert_eq!(agg.len(), 3);
        // First two have avg 1.5 (alpha and gamma tied), last has 3.0
        assert_eq!(agg[0].average_rank, 1.5);
        assert_eq!(agg[1].average_rank, 1.5);
        let tied: Vec<&str> = agg[..2].iter().map(|a| a.model.as_str()).collect();
        assert!(tied.contains(&"model-alpha"));
        assert!(tied.contains(&"model-gamma"));
        // model-beta: positions 3,3 → avg 3.0
        assert_eq!(agg[2].model, "model-beta");
        assert_eq!(agg[2].average_rank, 3.0);
        assert_eq!(agg[2].rankings_count, 2);
    }

    #[test]
    fn test_calculate_aggregate_rankings_partial() {
        // Test when not all models appear in every ranking
        let label_to_model: HashMap<String, String> = [
            ("Response A".into(), "model-alpha".into()),
            ("Response B".into(), "model-beta".into()),
        ]
        .into();

        let stage2 = vec![RankingResult {
            model: "model-alpha".into(),
            ranking: "FINAL RANKING:\n1. Response A".into(),
            parsed_ranking: vec![],
            latency_seconds: None,
            usage: None,
        }];

        let agg = calculate_aggregate_rankings(&stage2, &label_to_model);
        assert_eq!(agg.len(), 1);
        assert_eq!(agg[0].model, "model-alpha");
        assert_eq!(agg[0].average_rank, 1.0);
        assert_eq!(agg[0].rankings_count, 1);
    }
}
