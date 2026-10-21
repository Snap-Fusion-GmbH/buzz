//! Per-user GitHub CLI access; no GitHub token enters Buzz configuration.

use std::{
    path::Path,
    process::{Command, Output},
    time::Duration,
};

use serde::Serialize;
use url::Url;

use crate::managed_agents::{output_with_timeout, resolve_command_uncached};

/// Print only the compiled public GitHub organization for release smoke checks.
#[doc(hidden)]
pub fn print_github_organization_probe_if_requested() -> bool {
    if !std::env::args().any(|argument| argument == "--print-github-organization") {
        return false;
    }
    match organization() {
        Ok(Some(value)) => println!("{value}"),
        Ok(None) => println!("unmanaged"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
    true
}

/// Public connection state, with no token or credential-store contents.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccessStatus {
    /// Whether the per-user GitHub CLI can be resolved.
    pub cli_available: bool,
    /// The active GitHub login, without any credential-store payload.
    pub login: Option<String>,
    /// The compiled managed organization, or none for an unmanaged build.
    pub organization: Option<String>,
}

/// Recheck installation for explicit GitHub UI and foreground Git operations.
pub(crate) fn resolve_cli() -> Option<std::path::PathBuf> {
    resolve_command_uncached("gh")
}

/// Accept a credential-free HTTPS GitHub repository, not arbitrary git URLs.
pub(crate) fn repository_url(raw: &str) -> Result<Url, String> {
    let invalid = || "GitHub URL must use https://github.com/owner/repository".to_string();
    if raw.len() > 512
        || raw.trim() != raw
        || raw.contains('%')
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
        || raw.contains("/../")
        || raw.contains("/./")
    {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let parts: Vec<_> = url
        .path()
        .strip_prefix('/')
        .ok_or_else(invalid)?
        .trim_end_matches('/')
        .split('/')
        .collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 100
                || part.starts_with('-')
                || part.contains("..")
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return Err(invalid());
    }
    Ok(url)
}

/// Resolve the managed organization; an unconfigured managed build fails closed.
pub(crate) fn organization() -> Result<Option<String>, String> {
    match crate::managed_workspace::configuration()? {
        Some(config) => config
            .github_organization
            .map(Some)
            .ok_or_else(|| "GitHub access is not configured for this workspace".to_string()),
        None => Ok(None),
    }
}

pub(crate) fn validate_repository(raw: &str) -> Result<(), String> {
    validate_repository_for_organization(raw, organization()?.as_deref())
}

/// Keep corporate GitHub access inside the configured managed community.
pub(crate) fn validate_workspace(state: &crate::app_state::AppState) -> Result<(), String> {
    if let Some(config) = crate::managed_workspace::configuration()? {
        validate_managed_relay(
            &crate::relay::relay_ws_url_with_override(state),
            &config.relay_url,
        )?;
    }
    Ok(())
}

fn validate_managed_relay(active: &str, expected: &str) -> Result<(), String> {
    let active = Url::parse(active).map_err(|_| "GitHub workspace is invalid".to_string())?;
    let expected =
        Url::parse(expected).map_err(|_| "Managed GitHub workspace is invalid".to_string())?;
    if active != expected {
        return Err("GitHub access is limited to the managed workspace".into());
    }
    Ok(())
}

fn validate_repository_for_organization(
    raw: &str,
    organization: Option<&str>,
) -> Result<(), String> {
    let url = repository_url(raw)?;
    if let Some(organization) = organization {
        let owner = url.path_segments().and_then(|mut parts| parts.next());
        if !owner.is_some_and(|owner| owner.eq_ignore_ascii_case(organization)) {
            return Err(format!("GitHub repository must belong to {organization}"));
        }
    }
    Ok(())
}

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A path-scoped helper talks directly to the user's existing GitHub keychain.
pub(crate) fn credential_entries(url: &str, gh: &Path) -> Vec<(String, String)> {
    let path = gh.to_string_lossy().replace('\\', "/");
    vec![
        (
            format!("credential.{url}.helper"),
            format!("!{} auth git-credential", shell_quote(&path)),
        ),
        (format!("credential.{url}.useHttpPath"), "true".into()),
        ("http.followRedirects".into(), "false".into()),
    ]
}

/// Remove inherited overrides that could substitute an account or leak keys.
pub(crate) fn sanitize_environment(command: &mut Command) {
    let names: Vec<_> = std::env::vars_os()
        .map(|(name, _)| name)
        .chain(command.get_envs().map(|(name, _)| name.to_os_string()))
        .collect();
    for name in names {
        let key = name.to_string_lossy().to_ascii_uppercase();
        if key == "GIT_CONFIG"
            || key.starts_with("GIT_CONFIG_")
            || key == "GIT_TRACE"
            || key.starts_with("GIT_TRACE_")
            || matches!(
                key.as_str(),
                "GH_TOKEN"
                    | "GITHUB_TOKEN"
                    | "GH_ENTERPRISE_TOKEN"
                    | "GITHUB_ENTERPRISE_TOKEN"
                    | "GH_DEBUG"
                    | "NOSTR_PRIVATE_KEY"
                    | "BUZZ_PRIVATE_KEY"
                    | "BUZZ_AUTH_TAG"
                    | "GIT_ASKPASS"
                    | "SSH_ASKPASS"
                    | "GIT_CURL_VERBOSE"
            )
        {
            command.env_remove(name);
        }
    }
}

pub(crate) fn run_cli(gh: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new(gh);
    command.args(args);
    sanitize_environment(&mut command);
    command.env("GH_PROMPT_DISABLED", "1");
    command.env("GH_NO_UPDATE_NOTIFIER", "1");
    output_with_timeout(command, Duration::from_secs(20))
        .ok_or_else(|| "GitHub account check failed or timed out".to_string())
}

/// Read only the active account's login, never a token-bearing status payload.
pub(crate) fn status() -> Result<GitHubAccessStatus, String> {
    let organization = organization()?;
    let Some(gh) = resolve_cli() else {
        return Ok(GitHubAccessStatus {
            cli_available: false,
            login: None,
            organization,
        });
    };
    let output = run_cli(
        &gh,
        &["api", "--hostname", "github.com", "user", "--jq", ".login"],
    )?;
    if !output.status.success() {
        let diagnostic = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if diagnostic.contains("not logged")
            || diagnostic.contains("to get started with github cli")
            || diagnostic.contains("http 401")
            || diagnostic.contains("bad credentials")
        {
            return Ok(GitHubAccessStatus {
                cli_available: true,
                login: None,
                organization,
            });
        }
        return Err("Could not verify the GitHub account; retry when online".into());
    }
    let login = String::from_utf8(output.stdout)
        .map_err(|_| "GitHub returned an invalid account".to_string())?
        .trim()
        .to_string();
    if login.is_empty()
        || login.len() > 39
        || !login
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("GitHub returned an invalid account".into());
    }
    Ok(GitHubAccessStatus {
        cli_available: true,
        login: Some(login),
        organization,
    })
}

/// Launch the official interactive authorization in an OS terminal.
pub(crate) fn connect() -> Result<(), String> {
    organization()?;
    let gh = resolve_cli().ok_or_else(|| "GitHub CLI is not installed".to_string())?;
    launch_login(&gh)
}

#[cfg(target_os = "linux")]
fn launch_login(gh: &Path) -> Result<(), String> {
    for (terminal, prefix) in [
        ("x-terminal-emulator", "-e"),
        ("gnome-terminal", "--"),
        ("konsole", "-e"),
        ("xterm", "-e"),
    ] {
        let mut command = Command::new(terminal);
        command.arg(prefix).arg(gh).args([
            "auth",
            "login",
            "--web",
            "--hostname",
            "github.com",
            "--git-protocol",
            "https",
        ]);
        sanitize_environment(&mut command);
        if command.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("No terminal is available for GitHub sign-in".into())
}

#[cfg(any(target_os = "macos", all(test, unix)))]
fn macos_login_script(gh: &Path) -> Result<tempfile::NamedTempFile, String> {
    use std::{io::Write, os::unix::fs::PermissionsExt};

    let home = dirs::home_dir().ok_or_else(|| "Home directory is unavailable".to_string())?;
    let mut argv = vec![
        "/usr/bin/env".to_string(),
        "-i".to_string(),
        format!("HOME={}", home.to_string_lossy()),
    ];
    for name in ["PATH", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(name) {
            argv.push(format!("{name}={}", value.to_string_lossy()));
        }
    }
    argv.extend([
        gh.to_string_lossy().into_owned(),
        "auth".into(),
        "login".into(),
        "--web".into(),
        "--hostname".into(),
        "github.com".into(),
        "--git-protocol".into(),
        "https".into(),
    ]);
    let command = argv
        .iter()
        .map(|value| shell_quote(value))
        .collect::<Vec<_>>()
        .join(" ");
    let mut script = tempfile::Builder::new()
        .prefix("buzz-github-auth-")
        .suffix(".command")
        .tempfile()
        .map_err(|_| "Could not prepare GitHub sign-in".to_string())?;
    writeln!(
        script,
        "#!/bin/sh\ntrap '/bin/rm -f -- \"$0\"' EXIT\n{command}"
    )
    .map_err(|_| "Could not write GitHub sign-in script".to_string())?;
    std::fs::set_permissions(script.path(), std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "Could not protect GitHub sign-in script".to_string())?;
    Ok(script)
}

#[cfg(target_os = "macos")]
fn launch_login(gh: &Path) -> Result<(), String> {
    let script = macos_login_script(gh)?.into_temp_path();
    let mut process = Command::new("/usr/bin/open");
    process.args(["-a", "Terminal"]).arg(&script);
    sanitize_environment(&mut process);
    let result = output_with_timeout(process, Duration::from_secs(10))
        .ok_or_else(|| "Could not open GitHub sign-in".to_string())?;
    if !result.status.success() {
        return Err("Could not open GitHub sign-in".into());
    }
    script
        .keep()
        .map_err(|_| "Could not preserve GitHub sign-in script".to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_login(gh: &Path) -> Result<(), String> {
    let path = gh.to_string_lossy().replace('\'', "''");
    let mut command = Command::new("powershell");
    command.args([
        "-NoProfile",
        "-NoExit",
        "-Command",
        &format!("& '{path}' auth login --web --hostname github.com --git-protocol https"),
    ]);
    sanitize_environment(&mut command);
    command
        .spawn()
        .map_err(|_| "Could not open GitHub sign-in".to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn macos_login_script_quotes_the_cli_scrubs_terminal_secrets_and_removes_itself() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("fixture");
        let gh = root.path().join("Git Hub's CLI");
        std::fs::write(
            &gh,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" \"${GH_TOKEN-unset}\" \"${GITHUB_TOKEN-unset}\" \"${NOSTR_PRIVATE_KEY-unset}\" \"${BUZZ_PRIVATE_KEY-unset}\" \"${GH_DEBUG-unset}\" \"${GIT_CONFIG_PARAMETERS-unset}\"\n",
        ).expect("fake CLI");
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).expect("executable");
        let script = macos_login_script(&gh).expect("production login script");
        assert_eq!(
            script
                .as_file()
                .metadata()
                .expect("permissions")
                .permissions()
                .mode()
                & 0o777,
            0o700,
        );
        let mut command = Command::new("/bin/sh");
        command.arg(script.path());
        for name in [
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "NOSTR_PRIVATE_KEY",
            "BUZZ_PRIVATE_KEY",
            "GH_DEBUG",
            "GIT_CONFIG_PARAMETERS",
        ] {
            command.env(name, "fixture-secret");
        }
        let output = command.output().expect("run production login script");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).expect("UTF8"),
            "auth login --web --hostname github.com --git-protocol https\nunset\nunset\nunset\nunset\nunset\nunset\n",
        );
        assert!(!script.path().exists(), "Terminal owns script cleanup");
    }

    #[test]
    fn managed_github_cannot_follow_a_switch_to_another_community() {
        assert!(validate_managed_relay("wss://relay.example/", "wss://relay.example").is_ok());
        for other in [
            "wss://other.example",
            "ws://relay.example",
            "wss://relay.example/other",
        ] {
            assert!(validate_managed_relay(other, "wss://relay.example").is_err());
        }
    }

    #[test]
    fn repository_scope_rejects_credentials_other_hosts_and_other_organizations() {
        let url = "https://github.com/Snap-Fusion-GmbH/private-repo.git";
        assert!(validate_repository_for_organization(url, Some("Snap-Fusion-GmbH")).is_ok());
        for invalid in [
            "https://github.com/other/private-repo",
            "http://github.com/Snap-Fusion-GmbH/private-repo",
            "https://user:token@github.com/Snap-Fusion-GmbH/private-repo",
            "https://github.com.evil.test/Snap-Fusion-GmbH/private-repo",
            "https://github.com/Snap-Fusion-GmbH/private-repo?token=secret",
            "https://github.com/Snap-Fusion-GmbH/private-repo/issues",
            "https://github.com/other/../Snap-Fusion-GmbH/private-repo",
            "https://github.com/%53nap-Fusion-GmbH/private-repo",
            "https://git\nhub.com/Snap-Fusion-GmbH/private-repo",
            "https://github.com\\Snap-Fusion-GmbH/private-repo",
        ] {
            assert!(
                validate_repository_for_organization(invalid, Some("Snap-Fusion-GmbH")).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn helper_is_bound_to_the_exact_repository_and_quotes_the_executable() {
        let entries = credential_entries(
            "https://github.com/Snap-Fusion-GmbH/private.git",
            Path::new("/Applications/Git Hub/gh"),
        );
        assert_eq!(
            entries[0].0,
            "credential.https://github.com/Snap-Fusion-GmbH/private.git.helper"
        );
        assert_eq!(
            entries[0].1,
            "!'/Applications/Git Hub/gh' auth git-credential"
        );
        assert_eq!(entries[2], ("http.followRedirects".into(), "false".into()));
    }
}
