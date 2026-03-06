//! Adapter contract definitions and parity tests.
//!
//! Both the web (axum) and native (Tauri) adapters must emit the same event
//! types with the same payload shapes during a council run. This module defines
//! the canonical event contract and provides test helpers to verify conformance.

use serde::{Deserialize, Serialize};

/// All event types that adapters must emit during a streaming council run,
/// in the order they are expected.
pub const STREAMING_EVENT_ORDER: &[&str] = &[
    "upload_processing_start",
    "upload_processing_complete",
    "stage1_start",
    "stage1_complete",
    "stage2_start",
    "stage2_complete",
    "stage3_start",
    "stage3_complete",
    // title_complete is optional (only on first message)
    "complete",
];

/// A generic event envelope matching the JSON shape both adapters emit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CouncilEvent {
    #[serde(rename = "type")]
    pub event_type: String,

    // Stage 1 complete
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub timing: Option<serde_json::Value>,
    #[serde(default)]
    pub failed_models: Option<Vec<String>>,

    // Stage 2 complete, complete
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,

    // Upload processing complete
    #[serde(default)]
    pub attachments: Option<serde_json::Value>,

    // Error
    #[serde(default)]
    pub message: Option<String>,
}

/// Verify that a sequence of events follows the expected ordering contract.
/// Returns Ok(()) if valid, or Err with a description of the violation.
pub fn verify_event_ordering(events: &[CouncilEvent]) -> Result<(), String> {
    // Filter to only the events in our contract (ignore title_complete which is optional)
    let contract_types: std::collections::HashSet<&str> =
        STREAMING_EVENT_ORDER.iter().copied().collect();

    let filtered: Vec<&str> = events
        .iter()
        .map(|e| e.event_type.as_str())
        .filter(|t| contract_types.contains(t))
        .collect();

    if filtered.is_empty() {
        return Err("No contract events found in sequence".into());
    }

    // Verify ordering: each event type that appears must come after all preceding ones
    let mut last_idx: Option<usize> = None;
    for event_type in &filtered {
        let pos = STREAMING_EVENT_ORDER
            .iter()
            .position(|&t| t == *event_type)
            .ok_or_else(|| format!("Unknown event type: {event_type}"))?;

        if let Some(prev) = last_idx {
            if pos < prev {
                return Err(format!(
                    "Event '{}' appeared after '{}' but should come before it",
                    event_type, STREAMING_EVENT_ORDER[prev]
                ));
            }
        }
        last_idx = Some(pos);
    }

    Ok(())
}

/// Verify that stage completion events contain required payload fields.
pub fn verify_stage_payloads(events: &[CouncilEvent]) -> Result<(), String> {
    for event in events {
        match event.event_type.as_str() {
            "stage1_complete" => {
                if event.data.is_none() {
                    return Err("stage1_complete missing 'data' field".into());
                }
                if event.timing.is_none() {
                    return Err("stage1_complete missing 'timing' field".into());
                }
            }
            "stage2_complete" => {
                if event.data.is_none() {
                    return Err("stage2_complete missing 'data' field".into());
                }
                if event.metadata.is_none() {
                    return Err("stage2_complete missing 'metadata' field".into());
                }
            }
            "stage3_complete" => {
                if event.data.is_none() {
                    return Err("stage3_complete missing 'data' field".into());
                }
            }
            "complete" => {
                if event.metadata.is_none() {
                    return Err("complete missing 'metadata' field".into());
                }
            }
            "error" => {
                if event.message.is_none() {
                    return Err("error event missing 'message' field".into());
                }
            }
            _ => {} // start events and others have no required payload
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(event_type: &str) -> CouncilEvent {
        CouncilEvent {
            event_type: event_type.into(),
            data: None,
            timing: None,
            failed_models: None,
            metadata: None,
            attachments: None,
            message: None,
        }
    }

    fn make_full_stream() -> Vec<CouncilEvent> {
        vec![
            make_event("upload_processing_start"),
            CouncilEvent {
                event_type: "upload_processing_complete".into(),
                attachments: Some(serde_json::json!([])),
                ..make_event("upload_processing_complete")
            },
            make_event("stage1_start"),
            CouncilEvent {
                data: Some(serde_json::json!([{"model": "test", "response": "hi"}])),
                timing: Some(serde_json::json!(1.5)),
                failed_models: Some(vec![]),
                ..make_event("stage1_complete")
            },
            make_event("stage2_start"),
            CouncilEvent {
                data: Some(serde_json::json!([])),
                metadata: Some(serde_json::json!({})),
                timing: Some(serde_json::json!(1.2)),
                ..make_event("stage2_complete")
            },
            make_event("stage3_start"),
            CouncilEvent {
                data: Some(serde_json::json!({"model": "chair", "response": "final"})),
                timing: Some(serde_json::json!(2.0)),
                ..make_event("stage3_complete")
            },
            CouncilEvent {
                metadata: Some(serde_json::json!({})),
                ..make_event("complete")
            },
        ]
    }

    #[test]
    fn test_valid_event_ordering() {
        let events = make_full_stream();
        assert!(verify_event_ordering(&events).is_ok());
    }

    #[test]
    fn test_invalid_ordering_detected() {
        let events = vec![
            make_event("stage2_start"),
            make_event("stage1_start"), // wrong: stage1 should come before stage2
        ];
        let result = verify_event_ordering(&events);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("stage1_start"));
    }

    #[test]
    fn test_valid_stage_payloads() {
        let events = make_full_stream();
        assert!(verify_stage_payloads(&events).is_ok());
    }

    #[test]
    fn test_missing_stage1_data_detected() {
        let events = vec![CouncilEvent {
            timing: Some(serde_json::json!(1.0)),
            ..make_event("stage1_complete")
        }];
        let result = verify_stage_payloads(&events);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("stage1_complete missing 'data'"));
    }

    #[test]
    fn test_missing_complete_metadata_detected() {
        let events = vec![make_event("complete")];
        let result = verify_stage_payloads(&events);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("complete missing 'metadata'"));
    }

    #[test]
    fn test_error_event_requires_message() {
        let events = vec![make_event("error")];
        let result = verify_stage_payloads(&events);
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .contains("error event missing 'message'"));
    }

    #[test]
    fn test_error_event_with_message_ok() {
        let events = vec![CouncilEvent {
            message: Some("something went wrong".into()),
            ..make_event("error")
        }];
        assert!(verify_stage_payloads(&events).is_ok());
    }

    #[test]
    fn test_event_roundtrip_through_json() {
        // Verify the event envelope serializes/deserializes correctly
        // This is the contract both SSE (web) and Tauri events must follow
        let event = CouncilEvent {
            event_type: "stage1_complete".into(),
            data: Some(serde_json::json!([
                {"model": "openai/gpt-5.1", "response": "Hello", "latency_seconds": 1.5}
            ])),
            timing: Some(serde_json::json!(2.5)),
            failed_models: Some(vec!["x-ai/grok-4".into()]),
            metadata: None,
            attachments: None,
            message: None,
        };

        let json = serde_json::to_string(&event).unwrap();
        let parsed: CouncilEvent = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.event_type, "stage1_complete");
        assert!(parsed.data.is_some());
        assert!(parsed.timing.is_some());
        assert_eq!(parsed.failed_models.unwrap(), vec!["x-ai/grok-4"]);
    }

    #[test]
    fn test_sse_format_parsing() {
        // Simulate the exact SSE wire format: "data: {json}\n\n"
        let event_json = serde_json::json!({
            "type": "stage1_start"
        });
        let sse_line = format!("data: {}", event_json);

        // Parse it the same way the frontend does
        let data = sse_line.strip_prefix("data: ").unwrap();
        let parsed: CouncilEvent = serde_json::from_str(data).unwrap();
        assert_eq!(parsed.event_type, "stage1_start");
    }

    #[test]
    fn test_tauri_event_format_parsing() {
        // Tauri events arrive as: { payload: {the event json} }
        // The frontend accesses tauriEvent.payload
        let event_json = serde_json::json!({
            "type": "stage2_complete",
            "data": [],
            "metadata": {"label_to_model": {}, "aggregate_rankings": []},
            "timing": 3.2
        });

        // Verify this parses as a valid CouncilEvent
        let parsed: CouncilEvent = serde_json::from_value(event_json).unwrap();
        assert_eq!(parsed.event_type, "stage2_complete");
        assert!(parsed.metadata.is_some());
    }
}
