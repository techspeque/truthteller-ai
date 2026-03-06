use std::path::Path;

use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::errors::CouncilError;
use crate::types::{AppConfig, AppConfigResponse, CredentialsStatus};

const CONFIG_FILENAME: &str = "config.json";
const SECRETS_FILENAME: &str = "secrets.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SecretConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    openrouter_api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedOpenRouterKey {
    pub key: Option<String>,
    pub source: String,
    pub masked_hint: Option<String>,
}

/// Load configuration from `{data_dir}/config.json`, falling back to defaults.
pub fn load_config(data_dir: &Path) -> AppConfig {
    let path = data_dir.join(CONFIG_FILENAME);
    match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str(&contents) {
            Ok(cfg) => cfg,
            Err(e) => {
                warn!(error = %e, "Invalid config.json, using defaults");
                AppConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            debug!("No config.json found, using defaults");
            AppConfig::default()
        }
        Err(e) => {
            warn!(path = %path.display(), error = %e, "Failed to read config.json, using defaults");
            AppConfig::default()
        }
    }
}

/// Save configuration to `{data_dir}/config.json`.
pub fn save_config(data_dir: &Path, config: &AppConfig) -> Result<(), CouncilError> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(CONFIG_FILENAME);
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, json)?;
    info!("Saved config");
    Ok(())
}

fn load_secret_config(data_dir: &Path) -> SecretConfig {
    let path = data_dir.join(SECRETS_FILENAME);
    match std::fs::read_to_string(&path) {
        Ok(contents) => match serde_json::from_str(&contents) {
            Ok(s) => s,
            Err(e) => {
                warn!(error = %e, "Invalid secrets.json, using empty secrets");
                SecretConfig::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SecretConfig::default(),
        Err(e) => {
            warn!(path = %path.display(), error = %e, "Failed to read secrets.json, using empty secrets");
            SecretConfig::default()
        }
    }
}

fn save_secret_config(data_dir: &Path, secret: &SecretConfig) -> Result<(), CouncilError> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(SECRETS_FILENAME);
    let json = serde_json::to_string_pretty(secret)?;
    std::fs::write(&path, json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            warn!(error = %e, "Failed to set restrictive permissions on secrets.json");
        }
    }
    Ok(())
}

pub fn set_openrouter_api_key(data_dir: &Path, api_key: &str) -> Result<(), CouncilError> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err(CouncilError::Validation(
            "OpenRouter API key cannot be empty".to_string(),
        ));
    }
    let mut secret = load_secret_config(data_dir);
    secret.openrouter_api_key = Some(trimmed.to_string());
    save_secret_config(data_dir, &secret)?;
    info!("OpenRouter API key stored");
    Ok(())
}

pub fn clear_openrouter_api_key(data_dir: &Path) -> Result<(), CouncilError> {
    let mut secret = load_secret_config(data_dir);
    secret.openrouter_api_key = None;
    save_secret_config(data_dir, &secret)?;
    info!("OpenRouter API key cleared");
    Ok(())
}

pub fn resolve_openrouter_api_key(data_dir: &Path, env_api_key: &str) -> ResolvedOpenRouterKey {
    let env_key = env_api_key.trim();
    if !env_key.is_empty() {
        return ResolvedOpenRouterKey {
            key: Some(env_key.to_string()),
            source: "env".to_string(),
            masked_hint: mask_key(env_key),
        };
    }

    let secret = load_secret_config(data_dir);
    if let Some(stored) = secret.openrouter_api_key {
        let trimmed = stored.trim();
        if !trimmed.is_empty() {
            return ResolvedOpenRouterKey {
                key: Some(trimmed.to_string()),
                source: "stored".to_string(),
                masked_hint: mask_key(trimmed),
            };
        }
    }

    ResolvedOpenRouterKey {
        key: None,
        source: "missing".to_string(),
        masked_hint: None,
    }
}

pub fn load_config_response(data_dir: &Path, env_api_key: &str) -> AppConfigResponse {
    let config = load_config(data_dir);
    let resolved = resolve_openrouter_api_key(data_dir, env_api_key);
    let credentials = CredentialsStatus {
        openrouter_configured: resolved.key.is_some(),
        source: resolved.source,
        masked_hint: resolved.masked_hint,
    };
    AppConfigResponse {
        config,
        credentials,
    }
}

fn mask_key(value: &str) -> Option<String> {
    let v = value.trim();
    if v.len() < 8 {
        return None;
    }
    let prefix_len = 6.min(v.len());
    let suffix_len = 4.min(v.len().saturating_sub(prefix_len));
    let prefix = &v[..prefix_len];
    let suffix = &v[v.len() - suffix_len..];
    Some(format!("{prefix}...{suffix}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_load_config_defaults_when_missing() {
        let tmp = TempDir::new().unwrap();
        let config = load_config(tmp.path());
        assert_eq!(config.chairman_model, "google/gemini-3-pro-preview");
        assert_eq!(config.council_models.len(), 4);
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let config = AppConfig {
            council_models: vec!["model-a".into(), "model-b".into()],
            chairman_model: "model-a".into(),
            ..AppConfig::default()
        };
        save_config(tmp.path(), &config).unwrap();
        let loaded = load_config(tmp.path());
        assert_eq!(loaded.chairman_model, "model-a");
        assert_eq!(loaded.council_models, vec!["model-a", "model-b"]);
    }

    #[test]
    fn test_load_config_falls_back_on_invalid_json() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("config.json"), "not json").unwrap();
        let config = load_config(tmp.path());
        // Should fall back to defaults
        assert_eq!(config.council_models.len(), 4);
    }

    #[test]
    fn test_resolve_key_prefers_env() {
        let tmp = TempDir::new().unwrap();
        set_openrouter_api_key(tmp.path(), "sk-or-v1-stored").unwrap();
        let resolved = resolve_openrouter_api_key(tmp.path(), "sk-or-v1-env");
        assert_eq!(resolved.source, "env");
        assert_eq!(resolved.key.as_deref(), Some("sk-or-v1-env"));
    }

    #[test]
    fn test_resolve_key_falls_back_to_stored() {
        let tmp = TempDir::new().unwrap();
        set_openrouter_api_key(tmp.path(), "sk-or-v1-stored").unwrap();
        let resolved = resolve_openrouter_api_key(tmp.path(), "");
        assert_eq!(resolved.source, "stored");
        assert_eq!(resolved.key.as_deref(), Some("sk-or-v1-stored"));
    }

    #[test]
    fn test_clear_key() {
        let tmp = TempDir::new().unwrap();
        set_openrouter_api_key(tmp.path(), "sk-or-v1-stored").unwrap();
        clear_openrouter_api_key(tmp.path()).unwrap();
        let resolved = resolve_openrouter_api_key(tmp.path(), "");
        assert_eq!(resolved.source, "missing");
        assert!(resolved.key.is_none());
    }
}
