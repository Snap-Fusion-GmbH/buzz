//! Update checks for the agent harnesses the first-run setup manages: each
//! harness's ACP adapter (installed by Buzz from npm) and its vendor CLI.
//!
//! Installed versions come from the local install; latest versions from the
//! public npm registry, where both the adapters and the CLIs are published.
//! A version that cannot be read is reported as unknown, never as current.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::managed_agents::{known_acp_runtime_exact, resolve_command};

/// Harness id → the npm package that publishes its vendor CLI.
const SETUP_HARNESS_CLIS: [(&str, &str); 2] = [
    ("claude", "@anthropic-ai/claude-code"),
    ("codex", "@openai/codex"),
];

const NETWORK_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ComponentVersion {
    pub installed: Option<String>,
    pub latest: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarnessUpdateInfo {
    pub runtime_id: String,
    pub adapter: ComponentVersion,
    pub cli: ComponentVersion,
    /// What updating the CLI runs, shown before the user starts it.
    pub cli_update_command: Option<String>,
}

/// `(major, minor, patch)` of the first `x.y.z` in `text`.
pub(super) fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find_map(|candidate| {
            let mut parts = candidate.split('.');
            let version = (
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
                parts.next()?.parse().ok()?,
            );
            Some(version)
        })
}

fn component(installed: Option<String>, latest: Option<String>) -> ComponentVersion {
    let update_available = match (
        installed.as_deref().and_then(parse_version),
        latest.as_deref().and_then(parse_version),
    ) {
        (Some(installed), Some(latest)) => latest > installed,
        _ => false,
    };
    ComponentVersion {
        installed,
        latest,
        update_available,
    }
}

/// The npm package an adapter install command (`npm install -g <pkg>`) installs.
pub(super) fn adapter_package(install_commands: &[&str]) -> Option<String> {
    install_commands
        .iter()
        .find(|command| command.trim_start().starts_with("npm install -g "))
        .and_then(|command| command.split_whitespace().last())
        .map(str::to_string)
}

/// Pin an unversioned `npm install -g <pkg>` to `@latest` for an upgrade,
/// so npm replaces an installed adapter instead of keeping it.
pub(super) fn with_latest_tag(command: &str, upgrade: bool) -> String {
    let trimmed = command.trim();
    if !upgrade || !trimmed.starts_with("npm install -g ") {
        return command.to_string();
    }
    match trimmed.split_whitespace().last() {
        // A scoped name starts with '@'; any later '@' is already a version.
        Some(package) if package.rfind('@').unwrap_or(0) == 0 => format!("{trimmed}@latest"),
        _ => command.to_string(),
    }
}

/// Version of `package` from the `package.json` above an installed bin path.
fn installed_package_version(bin: &Path, package: &str) -> Option<String> {
    let resolved = std::fs::canonicalize(bin).ok()?;
    resolved.ancestors().skip(1).find_map(|dir| {
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("package.json")).ok()?).ok()?;
        (manifest["name"].as_str() == Some(package))
            .then(|| manifest["version"].as_str().map(str::to_string))
            .flatten()
    })
}

/// `<cli> --version`, bounded so a hung CLI cannot stall the check.
fn cli_version(cli: &Path) -> Option<String> {
    let mut command = std::process::Command::new(cli);
    command
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Some(path) = crate::managed_agents::readiness::cli_probe::augmented_path() {
        command.env("PATH", path);
    }
    crate::util::configure_no_window(&mut command);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(command.output());
    });
    let output = receiver.recv_timeout(VERSION_TIMEOUT).ok()?.ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let (major, minor, patch) = parse_version(&text)?;
    Some(format!("{major}.{minor}.{patch}"))
}

async fn latest_npm_version(client: &reqwest::Client, package: &str) -> Option<String> {
    let url = format!(
        "https://registry.npmjs.org/{}/latest",
        package.replacen('/', "%2F", 1)
    );
    let response = client
        .get(url)
        .timeout(NETWORK_TIMEOUT)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let body: serde_json::Value = response.json().await.ok()?;
    body["version"].as_str().map(str::to_string)
}

/// Installed and latest versions of each setup harness's adapter and CLI.
#[tauri::command]
pub async fn check_harness_updates(
    state: State<'_, AppState>,
) -> Result<Vec<HarnessUpdateInfo>, String> {
    let mut results = Vec::new();
    for (runtime_id, cli_package) in SETUP_HARNESS_CLIS {
        let Some(runtime) = known_acp_runtime_exact(runtime_id) else {
            continue;
        };
        let adapter_package = adapter_package(runtime.adapter_install_commands);
        let adapter_path = runtime
            .commands
            .iter()
            .find_map(|command| resolve_command(command));
        let cli_path = runtime.underlying_cli.and_then(resolve_command);
        let (installed_adapter, installed_cli) = tokio::task::spawn_blocking({
            let adapter_package = adapter_package.clone();
            move || {
                let adapter = adapter_path
                    .zip(adapter_package)
                    .and_then(|(path, package)| installed_package_version(&path, &package));
                let cli = cli_path.as_deref().and_then(cli_version);
                (adapter, cli)
            }
        })
        .await
        .map_err(|error| format!("harness version check failed: {error}"))?;
        let latest_adapter = match &adapter_package {
            Some(package) if installed_adapter.is_some() => {
                latest_npm_version(&state.http_client, package).await
            }
            _ => None,
        };
        let latest_cli = if installed_cli.is_some() {
            latest_npm_version(&state.http_client, cli_package).await
        } else {
            None
        };
        results.push(HarnessUpdateInfo {
            runtime_id: runtime_id.to_string(),
            adapter: component(installed_adapter, latest_adapter),
            cli: component(installed_cli, latest_cli),
            cli_update_command: super::super::agent_auth::cli_update_command(runtime_id),
        });
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::{adapter_package, component, parse_version, with_latest_tag};

    #[test]
    fn reads_versions_from_cli_and_package_output() {
        assert_eq!(parse_version("2.1.332 (Claude Code)"), Some((2, 1, 332)));
        assert_eq!(parse_version("codex-cli 0.64.0"), Some((0, 64, 0)));
        assert_eq!(parse_version("no version here"), None);
    }

    #[test]
    fn only_a_newer_known_latest_is_an_update() {
        let version = |value: &str| Some(value.to_string());
        assert!(component(version("0.112.0"), version("0.113.0")).update_available);
        assert!(!component(version("0.112.0"), version("0.112.0")).update_available);
        assert!(!component(version("1.0.0"), version("0.9.9")).update_available);
        // Unknown on either side is never reported as an update.
        assert!(!component(None, version("1.0.0")).update_available);
        assert!(!component(version("1.0.0"), None).update_available);
    }

    #[test]
    fn upgrades_pin_unversioned_adapter_installs_to_latest() {
        let install = "npm install -g @agentclientprotocol/claude-agent-acp";
        assert_eq!(
            adapter_package(&[install]).as_deref(),
            Some("@agentclientprotocol/claude-agent-acp")
        );
        assert_eq!(with_latest_tag(install, true), format!("{install}@latest"));
        assert_eq!(with_latest_tag(install, false), install);
        let pinned = "npm install -g @agentclientprotocol/codex-acp@1.10.0";
        assert_eq!(with_latest_tag(pinned, true), pinned);
        let uninstall = "npm uninstall -g @zed-industries/codex-acp";
        assert_eq!(with_latest_tag(uninstall, true), uninstall);
    }
}
