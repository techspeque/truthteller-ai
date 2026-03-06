mod routes;
mod sse;
mod state;

use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use tower_http::cors::{Any, CorsLayer};

use tracing::info;
use tracing_subscriber::EnvFilter;

use t2ai_core::openrouter;
use t2ai_core::storage;

use state::AppState;

async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "TruthTeller AI API"
    }))
}

#[tokio::main]
async fn main() {
    // Initialize structured logging (RUST_LOG env controls level, default info)
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    // Handle --migrate <dest> flag: copy legacy data to a target directory
    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 3 && args[1] == "--migrate" {
        let source: std::path::PathBuf = std::env::var("DATA_DIR")
            .unwrap_or_else(|_| "data".to_string())
            .into();
        let dest: std::path::PathBuf = args[2].clone().into();
        info!(?source, ?dest, "Migrating data");
        match t2ai_core::migrate::migrate_data(&source, &dest) {
            Ok(count) => {
                info!(count, "Migration complete");
                return;
            }
            Err(e) => {
                tracing::error!(error = %e, "Migration failed");
                std::process::exit(1);
            }
        }
    }

    // Load API key from environment
    let api_key = std::env::var("OPENROUTER_API_KEY").unwrap_or_else(|_| {
        // Try .env file
        if let Ok(contents) = std::fs::read_to_string(".env") {
            for line in contents.lines() {
                if let Some(val) = line.strip_prefix("OPENROUTER_API_KEY=") {
                    return val.trim().to_string();
                }
            }
        }
        tracing::warn!("OPENROUTER_API_KEY not set");
        String::new()
    });

    // Data directory defaults to ./data
    let data_dir: std::path::PathBuf = std::env::var("DATA_DIR")
        .unwrap_or_else(|_| "data".to_string())
        .into();

    // Ensure storage directories exist
    storage::ensure_dirs(&data_dir).expect("Failed to create data directories");

    let http_client = openrouter::create_client().expect("Failed to create HTTP client");
    let state = AppState::new(data_dir, api_key, http_client);

    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:3000".parse().unwrap(),
            "http://localhost:5173".parse().unwrap(),
        ])
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        // Health
        .route("/", get(health_check))
        // Conversations CRUD
        .route("/api/conversations", get(routes::list_conversations))
        .route("/api/conversations", post(routes::create_conversation))
        .route(
            "/api/conversations/{conversation_id}",
            get(routes::get_conversation),
        )
        .route(
            "/api/conversations/{conversation_id}",
            delete(routes::delete_conversation),
        )
        // Config
        .route("/api/config", get(routes::get_config))
        .route("/api/config", put(routes::update_config))
        .route("/api/storage/info", get(routes::get_storage_info))
        .route(
            "/api/config/credentials/openrouter",
            post(routes::set_openrouter_api_key),
        )
        .route(
            "/api/config/credentials/openrouter",
            delete(routes::clear_openrouter_api_key),
        )
        .route(
            "/api/config/credentials/openrouter/test",
            post(routes::test_openrouter_api_key),
        )
        // Models
        .route("/api/models", get(routes::get_available_models))
        // Message (non-streaming, JSON body)
        .route(
            "/api/conversations/{conversation_id}/message",
            post(routes::send_message),
        )
        // Message (non-streaming, multipart with files)
        .route(
            "/api/conversations/{conversation_id}/message/upload",
            post(routes::send_message_multipart),
        )
        // Message (streaming, multipart with files)
        .route(
            "/api/conversations/{conversation_id}/message/stream",
            post(sse::send_message_stream),
        )
        // Message (streaming, JSON body — no files)
        .route(
            "/api/conversations/{conversation_id}/message/stream/json",
            post(sse::send_message_stream_json),
        )
        // Retry failed models
        .route(
            "/api/conversations/{conversation_id}/retry",
            post(routes::retry_failed_models),
        )
        // Rerun assistant stages
        .route(
            "/api/conversations/{conversation_id}/rerun",
            post(routes::rerun_assistant_stages),
        )
        .with_state(state)
        .layer(cors);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8001").await.unwrap();

    info!("TruthTeller AI server listening on http://0.0.0.0:8001");
    axum::serve(listener, app).await.unwrap();
}
