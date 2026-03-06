use thiserror::Error;

#[derive(Debug, Error)]
pub enum CouncilError {
    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("API error: {0}")]
    Api(String),

    #[error("Extraction error: {0}")]
    Extraction(String),

    #[error("Storage error: {0}")]
    Storage(String),

    #[error("Request error: {0}")]
    Request(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}
