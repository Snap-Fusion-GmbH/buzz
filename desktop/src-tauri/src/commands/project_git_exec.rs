//! Shared git subprocess plumbing for the project commands.
//!
//! Runs the system `git` with an ephemeral, env-only auth configuration:
//! the identity nsec is handed to `git-credential-nostr` via environment
//! variables so nothing key-related ever touches disk or global git config.

use crate::{
    app_state::AppState,
    github_access,
    managed_agents::{output_with_limit, resolve_command},
};
use nostr::{Keys, ToBech32};
use std::process::Command;
use std::time::Duration;
use url::Url;

/// Wall-clock cap for a single git invocation. Remote operations talk to
/// relay-supplied clone URLs, so a slow or adversarial remote must not pin
/// `spawn_blocking` threads indefinitely.
const LOCAL_GIT_TIMEOUT: Duration = Duration::from_secs(60);
const REMOTE_GIT_TIMEOUT: Duration = Duration::from_secs(300);

#[cfg(all(test, unix))]
#[path = "project_git_exec_live_tests.rs"]
mod live_tests;

fn git_subcommand<'a>(args: &'a [&str]) -> Option<&'a str> {
    let mut index = 0;
    while let Some(argument) = args.get(index).copied() {
        match argument {
            "-c" | "--config" | "-C" | "--git-dir" | "--work-tree" => index += 2,
            "--no-pager" | "--paginate" | "--end-of-options" => index += 1,
            argument
                if argument.starts_with("--config=")
                    || argument.starts_with("--git-dir=")
                    || argument.starts_with("--work-tree=") =>
            {
                index += 1;
            }
            argument if argument.starts_with('-') => index += 1,
            subcommand => return Some(subcommand),
        }
    }
    None
}

fn git_needs_credentials(args: &[&str]) -> bool {
    matches!(
        git_subcommand(args),
        Some("clone" | "fetch" | "push" | "pull" | "ls-remote" | "merge")
    )
}

pub(crate) struct GitAuthConfig {
    git_path: std::path::PathBuf,
    credential_helper: Option<std::path::PathBuf>,
    github_entries: Vec<(String, String)>,
    nsec: String,
    allow_file_transport: bool,
}

pub(crate) fn run_git(
    args: &[&str],
    cwd: Option<&std::path::Path>,
    auth: &GitAuthConfig,
) -> Result<String, String> {
    let mut command = Command::new(&auth.git_path);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let needs_credentials = git_needs_credentials(args);
    let timeout = if needs_credentials || !auth.github_entries.is_empty() {
        REMOTE_GIT_TIMEOUT
    } else {
        LOCAL_GIT_TIMEOUT
    };
    configure_git_auth(&mut command, auth, needs_credentials);
    let output = output_with_limit(command, timeout, 16 * 1024 * 1024)
        .ok_or_else(|| "Git failed, timed out, or exceeded its output limit".to_string())?;
    if !output.status.success() {
        let stderr = crate::managed_agents::redact_secrets_with(
            String::from_utf8_lossy(&output.stderr).trim(),
            &[auth.nsec.as_str()],
        );
        return Err(if stderr.is_empty() {
            format!("git exited with status {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn configure_git_auth(command: &mut Command, auth: &GitAuthConfig, needs_credentials: bool) {
    github_access::sanitize_environment(command);
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_CONFIG_NOSYSTEM", "1");
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_SSH_COMMAND",
        "GIT_EXTERNAL_DIFF",
    ] {
        command.env_remove(key);
    }
    // Git for Windows maps `/dev/null` to `NUL` internally, so this value
    // disables the global config file on every platform.
    command.env("GIT_CONFIG_GLOBAL", "/dev/null");

    // Base entries: disable any inherited credential helper, and neutralize
    // repo-local hooks — every process git spawns inherits our environment
    // (including NOSTR_PRIVATE_KEY below), and a cloned repository's hooks
    // must never run with the identity key in reach.
    let mut entries: Vec<(String, String)> = vec![
        ("credential.helper".into(), String::new()),
        ("core.hooksPath".into(), "/dev/null".to_string()),
        ("core.fsmonitor".into(), "false".to_string()),
        ("protocol.allow".into(), "never".to_string()),
        ("protocol.http.allow".into(), "always".to_string()),
        ("protocol.https.allow".into(), "always".to_string()),
        ("protocol.ext.allow".into(), "never".to_string()),
        (
            "protocol.file.allow".into(),
            if auth.allow_file_transport {
                "always"
            } else {
                "never"
            }
            .to_string(),
        ),
    ];
    // Promisor reads such as `show` may fetch cold blobs. The scoped helper is
    // safe on local operations too: it contains no token or Buzz identity key.
    if !auth.github_entries.is_empty() {
        entries.extend_from_slice(&auth.github_entries);
    } else if needs_credentials {
        let Some(cred_helper) = &auth.credential_helper else {
            return apply_git_config(command, &entries);
        };
        command.env("NOSTR_PRIVATE_KEY", &auth.nsec);
        entries.push((
            "credential.helper".into(),
            credential_helper_config_value(cred_helper),
        ));
        entries.push(("credential.useHttpPath".into(), "true".to_string()));
    }
    apply_git_config(command, &entries);
}

/// Format a path for git `credential.helper`.
///
/// Git for Windows invokes helpers via MinGW bash, which treats `\` as
/// escapes. Forward slashes work on every platform git supports.
fn credential_helper_config_value(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn apply_git_config(command: &mut Command, entries: &[(String, String)]) {
    command.env("GIT_CONFIG_COUNT", entries.len().to_string());
    for (index, (key, value)) in entries.iter().enumerate() {
        command.env(format!("GIT_CONFIG_KEY_{index}"), key);
        command.env(format!("GIT_CONFIG_VALUE_{index}"), value);
    }
}

pub(crate) fn build_git_auth_config(state: &AppState) -> Result<GitAuthConfig, String> {
    let keys = state.signing_keys()?;
    build_git_auth_config_for_keys(&keys)
}

pub(crate) fn build_git_clone_auth_config(
    clone_url: &str,
    state: &AppState,
) -> Result<GitAuthConfig, String> {
    validate_local_clone_url_for_workspace(clone_url, state)?;
    if validate_github_clone_url(clone_url).is_ok() {
        github_access::validate_workspace(state)?;
        github_access::validate_repository(clone_url)?;
        return build_github_auth_config(clone_url, github_access::resolve_cli().as_deref());
    }
    build_git_auth_config(state)
}

fn build_github_auth_config(
    clone_url: &str,
    gh: Option<&std::path::Path>,
) -> Result<GitAuthConfig, String> {
    github_access::repository_url(clone_url)?;
    Ok(GitAuthConfig {
        git_path: resolve_command("git").ok_or_else(|| "git was not found on PATH".to_string())?,
        credential_helper: None,
        github_entries: gh
            .map(|path| github_access::credential_entries(clone_url, path))
            .unwrap_or_default(),
        nsec: String::new(),
        allow_file_transport: false,
    })
}

pub(crate) fn build_git_auth_config_for_keys(keys: &Keys) -> Result<GitAuthConfig, String> {
    let git_path = resolve_command("git").ok_or_else(|| "git was not found on PATH".to_string())?;
    let credential_helper = resolve_command("git-credential-nostr");
    let nsec = keys
        .secret_key()
        .to_bech32()
        .map_err(|error| format!("encode identity key: {error}"))?;
    Ok(GitAuthConfig {
        git_path,
        credential_helper,
        github_entries: Vec::new(),
        nsec,
        allow_file_transport: false,
    })
}

#[cfg(test)]
pub(crate) fn build_test_git_auth_config() -> Result<GitAuthConfig, String> {
    let mut auth = build_git_auth_config_for_keys(&Keys::generate())?;
    auth.allow_file_transport = true;
    Ok(auth)
}

/// Normalizes and validates a relay-supplied branch name. Strips a
/// `refs/heads/` prefix, then rejects anything outside a conservative
/// character allowlist, path traversal (`..`), leading/trailing `/`, and
/// flag-shaped values (leading `-`) so a branch can never reach git as an
/// option instead of a positional argument.
pub(crate) fn clean_branch(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.trim_start_matches("refs/heads/"))
        .filter(|value| {
            !value.is_empty()
                && !value.starts_with('-')
                && !value.contains("..")
                && !value.starts_with('/')
                && !value.ends_with('/')
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '.' | '-'))
        })
        .map(ToString::to_string)
}

pub(crate) fn clean_target_ref(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_string();
    for prefix in ["refs/tags/", "refs/nostr/"] {
        if let Some(name) = value.strip_prefix(prefix) {
            let clean_name = clean_branch(Some(name.to_string()))?;
            return (clean_name == name).then_some(format!("{prefix}{clean_name}"));
        }
    }
    None
}

pub(crate) fn validate_clone_url(clone_url: &str) -> Result<(), String> {
    let parsed = Url::parse(clone_url).map_err(|error| format!("invalid clone URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("clone URL must be http or https".into());
    }
    // Buzz git remotes are served at `…/git/<owner-pubkey>/<repo-id>` — a
    // literal `git` segment followed by the 64-hex owner pubkey and a
    // non-empty repository id (the relay may live under a path prefix).
    let segments = parsed
        .path_segments()
        .map(|segments| segments.filter(|s| !s.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    let is_buzz_repo_path = segments
        .iter()
        .rposition(|segment| *segment == "git")
        .filter(|index| segments.len() == index + 3)
        .map(|index| {
            segments[index + 1].len() == 64
                && segments[index + 1].chars().all(|c| c.is_ascii_hexdigit())
                && !segments[index + 2].is_empty()
        })
        .unwrap_or(false);
    if !is_buzz_repo_path {
        return Err("clone URL must point at a Buzz git repository".into());
    }
    Ok(())
}

fn validate_github_clone_url(clone_url: &str) -> Result<(), String> {
    github_access::repository_url(clone_url).map(|_| ())
}

pub(crate) fn validate_local_clone_url(clone_url: &str) -> Result<(), String> {
    if validate_clone_url(clone_url).is_ok() || validate_github_clone_url(clone_url).is_ok() {
        return Ok(());
    }
    Err("clone URL must point at a Buzz repository or HTTPS GitHub repository".into())
}

pub(crate) fn validate_local_clone_url_for_workspace(
    clone_url: &str,
    state: &AppState,
) -> Result<(), String> {
    if validate_github_clone_url(clone_url).is_ok() {
        github_access::validate_workspace(state)?;
        return github_access::validate_repository(clone_url);
    }
    validate_workspace_clone_url(clone_url, state)
}

pub(crate) fn clone_url_owner(clone_url: &str) -> Option<String> {
    let parsed = Url::parse(clone_url).ok()?;
    let segments = parsed
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    let index = segments.iter().rposition(|segment| *segment == "git")?;
    (segments.len() == index + 3).then(|| segments[index + 1].to_ascii_lowercase())
}

pub(crate) fn validate_workspace_clone_url(
    clone_url: &str,
    state: &AppState,
) -> Result<(), String> {
    let relay_base = crate::relay::relay_api_base_url_with_override(state);
    validate_clone_url_against_relay(clone_url, &relay_base)
}

fn validate_clone_url_against_relay(clone_url: &str, relay_base: &str) -> Result<(), String> {
    validate_clone_url(clone_url)?;
    let clone = Url::parse(clone_url).map_err(|error| format!("invalid clone URL: {error}"))?;
    let relay = Url::parse(relay_base)
        .map_err(|error| format!("configured relay URL is invalid: {error}"))?;
    if clone.scheme() != relay.scheme()
        || clone.host_str() != relay.host_str()
        || clone.port_or_known_default() != relay.port_or_known_default()
    {
        return Err("clone URL must use the active workspace relay".into());
    }
    let relay_path = relay.path().trim_end_matches('/');
    if !relay_path.is_empty() && !clone.path().starts_with(&format!("{relay_path}/")) {
        return Err("clone URL must use the active workspace relay path".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clean_branch, clean_target_ref, credential_helper_config_value, git_needs_credentials,
        git_subcommand, validate_clone_url, validate_clone_url_against_relay,
        validate_local_clone_url,
    };

    #[test]
    fn github_auth_uses_only_the_exact_repository_helper_without_a_buzz_key() {
        let url = "https://github.com/Snap-Fusion-GmbH/private.git";
        let gh = std::path::Path::new("/opt/Git Hub/gh");
        let auth = super::build_github_auth_config(url, Some(gh)).expect("GitHub config");
        assert!(auth.nsec.is_empty());
        assert!(auth.credential_helper.is_none());
        let mut command = std::process::Command::new("git");
        for name in [
            "NOSTR_PRIVATE_KEY",
            "BUZZ_PRIVATE_KEY",
            "BUZZ_AUTH_TAG",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GIT_CONFIG_PARAMETERS",
            "GIT_TRACE_CURL",
        ] {
            command.env(name, "fixture-secret");
        }
        super::configure_git_auth(&mut command, &auth, true);
        let environment: std::collections::HashMap<_, _> = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for name in [
            "NOSTR_PRIVATE_KEY",
            "BUZZ_PRIVATE_KEY",
            "BUZZ_AUTH_TAG",
            "GH_TOKEN",
            "GITHUB_TOKEN",
            "GIT_CONFIG_PARAMETERS",
            "GIT_TRACE_CURL",
        ] {
            assert_eq!(environment.get(name), Some(&None), "{name} must be removed");
        }
        let helper = super::run_git(
            &["config", "--get-urlmatch", "credential.helper", url],
            None,
            &auth,
        )
        .expect("scoped helper");
        assert_eq!(helper.trim(), "!'/opt/Git Hub/gh' auth git-credential");
        for unrelated in [
            "https://github.com/Snap-Fusion-GmbH/another.git",
            "https://github.com/Snap-Fusion-GmbH/private.git-other",
            "https://github.com.evil.test/Snap-Fusion-GmbH/private.git",
        ] {
            let helper = super::run_git(
                &["config", "--get-urlmatch", "credential.helper", unrelated],
                None,
                &auth,
            )
            .unwrap_or_default();
            assert!(
                helper.trim().is_empty(),
                "credentials must not match {unrelated}"
            );
        }
        assert_eq!(
            super::run_git(
                &["config", "--get-urlmatch", "http.followRedirects", url],
                None,
                &auth
            )
            .expect("redirect policy")
            .trim(),
            "false"
        );
    }

    #[cfg(unix)]
    #[test]
    fn push_keeps_the_checked_commit_when_another_process_advances_head() {
        use std::os::unix::fs::PermissionsExt;
        let mut auth = super::build_test_git_auth_config().expect("git config");
        let root = tempfile::tempdir().expect("fixture");
        let remote = root.path().join("remote.git");
        let checkout = root.path().join("checkout");
        super::run_git(
            &["init", "--bare", "--", remote.to_str().expect("path")],
            None,
            &auth,
        )
        .expect("remote");
        super::run_git(
            &[
                "init",
                "--initial-branch=main",
                "--",
                checkout.to_str().expect("path"),
            ],
            None,
            &auth,
        )
        .expect("checkout");
        super::run_git(
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "Checked commit",
            ],
            Some(&checkout),
            &auth,
        )
        .expect("commit");
        super::run_git(
            &["remote", "add", "origin", remote.to_str().expect("path")],
            Some(&checkout),
            &auth,
        )
        .expect("origin");
        let expected = super::run_git(&["rev-parse", "HEAD"], Some(&checkout), &auth)
            .expect("head")
            .trim()
            .to_string();
        let git = crate::github_access::shell_quote(&auth.git_path.to_string_lossy());
        let proxy = root.path().join("git-proxy");
        std::fs::write(&proxy, format!(
            "#!/bin/sh\nset -eu\nif [ \"$1\" = push ]; then\n{git} -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -m 'Concurrent commit' >/dev/null\nfi\nexec {git} \"$@\"\n"
        )).expect("proxy");
        std::fs::set_permissions(&proxy, std::fs::Permissions::from_mode(0o700))
            .expect("executable");
        auth.git_path = proxy;
        let result = crate::commands::project_git_push::push_project_local_repository_blocking(
            &checkout,
            remote.to_string_lossy().into_owned(),
            Some("main".into()),
            None,
            &auth,
        )
        .expect("push checked snapshot");
        assert_eq!(result.commit, expected);
        let actual = super::run_git(
            &[
                "ls-remote",
                remote.to_str().expect("path"),
                "refs/heads/main",
            ],
            None,
            &auth,
        )
        .expect("remote readback");
        assert!(
            actual.starts_with(&expected),
            "push must not send the concurrently advanced HEAD"
        );
        let head =
            super::run_git(&["rev-parse", "HEAD"], Some(&checkout), &auth).expect("new head");
        assert_ne!(head.trim(), expected, "the race must actually advance HEAD");
    }

    #[test]
    fn credential_helper_config_value_uses_forward_slashes() {
        let path =
            std::path::PathBuf::from(r"C:\Users\x\AppData\Local\Buzz\git-credential-nostr.exe");
        assert_eq!(
            credential_helper_config_value(&path),
            "C:/Users/x/AppData/Local/Buzz/git-credential-nostr.exe",
        );
    }

    #[test]
    fn git_subcommand_skips_global_config_options() {
        assert_eq!(
            git_subcommand(&[
                "-c",
                "user.name=Buzz User",
                "-c",
                "user.email=user@example.com",
                "merge",
                "HEAD",
            ]),
            Some("merge")
        );
        assert_eq!(
            git_subcommand(&["--config=credential.useHttpPath=true", "fetch", "origin"]),
            Some("fetch")
        );
    }

    #[test]
    fn remote_and_promisor_operations_receive_credentials() {
        assert!(git_needs_credentials(&["fetch", "origin"]));
        assert!(git_needs_credentials(&[
            "-c",
            "user.name=Buzz User",
            "merge",
            "HEAD"
        ]));
        assert!(!git_needs_credentials(&["rev-parse", "HEAD"]));
    }

    #[test]
    fn clean_branch_accepts_plain_and_prefixed_names() {
        assert_eq!(
            clean_branch(Some("refs/heads/feature/x-1".into())),
            Some("feature/x-1".to_string())
        );
        assert_eq!(
            clean_branch(Some(" main ".into())),
            Some("main".to_string())
        );
    }

    #[test]
    fn clean_branch_rejects_flag_shaped_and_traversal_values() {
        assert_eq!(clean_branch(Some("--upload-pack=/tmp/evil".into())), None);
        assert_eq!(clean_branch(Some("-x".into())), None);
        assert_eq!(clean_branch(Some("a/../b".into())), None);
        assert_eq!(clean_branch(Some("/leading".into())), None);
        assert_eq!(clean_branch(Some("trailing/".into())), None);
        assert_eq!(clean_branch(Some("bad name".into())), None);
        assert_eq!(clean_branch(None), None);
    }

    #[test]
    fn clean_target_ref_accepts_only_tags_and_pull_request_refs() {
        assert_eq!(
            clean_target_ref(Some("refs/tags/v1.0.0".into())),
            Some("refs/tags/v1.0.0".to_string())
        );
        assert_eq!(
            clean_target_ref(Some("refs/nostr/abc123".into())),
            Some("refs/nostr/abc123".to_string())
        );
        assert_eq!(clean_target_ref(Some("refs/heads/main".into())), None);
        assert_eq!(clean_target_ref(Some("refs/tags/../main".into())), None);
    }

    #[test]
    fn validate_clone_url_requires_buzz_repo_shape() {
        let owner = "a".repeat(64);
        assert!(validate_clone_url(&format!("https://relay.example/git/{owner}/repo")).is_ok());
        assert!(
            validate_clone_url(&format!("https://relay.example/prefix/git/{owner}/repo")).is_ok()
        );
        assert!(validate_clone_url("https://relay.example/git/short/repo").is_err());
        assert!(validate_clone_url("https://evil.example/has/git/inpath").is_err());
        assert!(validate_clone_url(&format!("ssh://relay.example/git/{owner}/repo")).is_err());
        assert!(validate_clone_url(&format!(
            "https://relay.example/git/{owner}/repo/unexpected"
        ))
        .is_err());
    }

    #[test]
    fn workspace_clone_url_requires_exact_relay_origin_and_prefix() {
        let owner = "a".repeat(64);
        let valid = format!("https://relay.example/prefix/git/{owner}/repo");
        assert!(validate_clone_url_against_relay(&valid, "https://relay.example/prefix").is_ok());
        assert!(validate_clone_url_against_relay(&valid, "http://relay.example/prefix").is_err());
        assert!(
            validate_clone_url_against_relay(&valid, "https://relay.example:8443/prefix").is_err()
        );
        assert!(validate_clone_url_against_relay(&valid, "https://relay.example/other").is_err());
        assert!(validate_clone_url_against_relay(
            &format!("https://evil.example/prefix/git/{owner}/repo"),
            "https://relay.example/prefix",
        )
        .is_err());
    }

    #[test]
    fn local_clone_url_allows_only_public_github_https_urls() {
        assert!(validate_local_clone_url("https://github.com/block/buzz").is_ok());
        assert!(validate_local_clone_url("https://github.com/block/buzz.git").is_ok());
        assert!(validate_local_clone_url("http://github.com/block/buzz").is_err());
        assert!(validate_local_clone_url("https://github.com/block/buzz/issues").is_err());
        assert!(validate_local_clone_url("https://user@github.com/block/buzz").is_err());
        assert!(validate_local_clone_url("https://github.com.evil.test/block/buzz").is_err());
        assert!(validate_local_clone_url("https://gitlab.com/block/buzz").is_err());
    }
}
