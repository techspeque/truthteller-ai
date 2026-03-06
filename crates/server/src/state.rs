//! Shared application state for the web server.

use std::path::PathBuf;
use std::sync::Arc;

use reqwest::Client;

/// Shared state accessible by all route handlers.
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Inner>,
}

struct Inner {
    pub data_dir: PathBuf,
    pub api_key: String,
    pub http_client: Client,
}

impl AppState {
    pub fn new(data_dir: PathBuf, api_key: String, http_client: Client) -> Self {
        Self {
            inner: Arc::new(Inner {
                data_dir,
                api_key,
                http_client,
            }),
        }
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.inner.data_dir
    }

    pub fn api_key(&self) -> &str {
        &self.inner.api_key
    }

    pub fn http_client(&self) -> &Client {
        &self.inner.http_client
    }
}
