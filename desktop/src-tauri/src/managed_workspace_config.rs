use serde::{Deserialize, Serialize};

/// Public, compiled configuration for an organization-managed desktop build.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedWorkspaceConfig {
    pub workspace_id: String,
    pub tenant_id: String,
    pub desktop_client_id: String,
    pub api_client_id: String,
    pub base_url: String,
    pub relay_url: String,
    /// Restrict managed per-user GitHub operations to this organization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_organization: Option<String>,
}

impl ManagedWorkspaceConfig {
    /// Parse and validate the credential-free managed-build configuration.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let mut value: Self = serde_json::from_str(raw)
            .map_err(|_| "Managed workspace configuration is invalid".to_string())?;
        if value.workspace_id.is_empty()
            || value.workspace_id.len() > 48
            || !value
                .workspace_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err("Managed workspace identifier is invalid".into());
        }
        for identifier in [
            &value.tenant_id,
            &value.desktop_client_id,
            &value.api_client_id,
        ] {
            uuid::Uuid::parse_str(identifier)
                .map_err(|_| "Managed workspace identity is invalid".to_string())?;
        }
        if let Some(organization) = value.github_organization.as_deref() {
            if organization.is_empty()
                || organization.len() > 39
                || organization.starts_with('-')
                || organization.ends_with('-')
                || organization.contains("--")
                || !organization
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("Managed GitHub organization is invalid".into());
            }
        }
        for (raw_url, scheme) in [(&value.base_url, "https"), (&value.relay_url, "wss")] {
            let parsed = url::Url::parse(raw_url)
                .map_err(|_| "Managed workspace endpoint is invalid".to_string())?;
            if parsed.scheme() != scheme
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || parsed.query().is_some()
                || parsed.fragment().is_some()
                || !matches!(parsed.path(), "" | "/")
            {
                return Err("Managed workspace endpoints must be secure origins".into());
            }
        }
        value.base_url = value.base_url.trim_end_matches('/').to_string();
        value.relay_url = value.relay_url.trim_end_matches('/').to_string();
        Ok(value)
    }

    /// Dedicated OS-keyring namespace for Microsoft authorization.
    pub fn auth_service(&self) -> String {
        format!("buzz-managed-auth.{}", self.workspace_id)
    }

    /// Dedicated OS-keyring namespace for the individual workspace identity.
    pub fn identity_service(&self) -> String {
        format!("buzz-managed-identity.{}", self.workspace_id)
    }
}

#[cfg(test)]
mod tests {
    use super::ManagedWorkspaceConfig;

    fn fixture() -> serde_json::Value {
        serde_json::json!({
            "workspace_id": "snap-fusion-test",
            "tenant_id": "00000000-0000-4000-8000-000000000001",
            "desktop_client_id": "00000000-0000-4000-8000-000000000002",
            "api_client_id": "00000000-0000-4000-8000-000000000003",
            "base_url": "https://workspace.example.invalid",
            "relay_url": "wss://relay.example.invalid"
        })
    }

    #[test]
    fn public_configuration_cannot_carry_a_provider_credential() {
        let mut value = fixture();
        assert!(ManagedWorkspaceConfig::parse(&value.to_string()).is_ok());
        value["api_key"] = serde_json::json!("not-a-real-key");
        assert!(ManagedWorkspaceConfig::parse(&value.to_string()).is_err());
    }

    #[test]
    fn endpoint_credentials_and_insecure_urls_are_rejected() {
        for endpoint in [
            "http://workspace.example.invalid",
            "https://user:password@workspace.example.invalid",
            "https://workspace.example.invalid/?token=fixture",
        ] {
            let mut value = fixture();
            value["base_url"] = serde_json::json!(endpoint);
            assert!(ManagedWorkspaceConfig::parse(&value.to_string()).is_err());
        }
    }

    #[test]
    fn identity_and_auth_storage_are_separate_and_workspace_scoped() {
        let first = ManagedWorkspaceConfig::parse(&fixture().to_string()).unwrap();
        let mut changed = fixture();
        changed["workspace_id"] = serde_json::json!("other-workspace");
        let second = ManagedWorkspaceConfig::parse(&changed.to_string()).unwrap();
        assert_ne!(first.identity_service(), first.auth_service());
        assert_ne!(first.identity_service(), second.identity_service());
        assert_ne!(first.auth_service(), second.auth_service());
    }
}
