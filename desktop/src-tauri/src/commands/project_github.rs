//! Per-user GitHub connection and authenticated repository ref discovery.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    app_state::AppState,
    github_access::{self, GitHubAccessStatus},
};

use super::project_git_exec::{build_git_clone_auth_config, clean_branch, run_git};

/// Check the current user's GitHub CLI/keychain connection.
#[tauri::command]
pub async fn get_github_access_status(
    state: State<'_, AppState>,
) -> Result<GitHubAccessStatus, String> {
    github_access::validate_workspace(&state)?;
    tauri::async_runtime::spawn_blocking(github_access::status)
        .await
        .map_err(|_| "GitHub account check failed".to_string())?
}

/// Open the official per-user GitHub CLI browser authorization.
#[tauri::command]
pub async fn connect_github_account(state: State<'_, AppState>) -> Result<(), String> {
    github_access::validate_workspace(&state)?;
    tauri::async_runtime::spawn_blocking(github_access::connect)
        .await
        .map_err(|_| "Could not open GitHub sign-in".to_string())?
}

/// One branch or tag in the authenticated GitHub repository.
#[derive(Serialize)]
pub struct GitHubRepoRef {
    name: String,
    commit: String,
}

/// Authenticated GitHub default branch, branch tips and tag tips.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepoState {
    head: Option<String>,
    branches: Vec<GitHubRepoRef>,
    tags: Vec<GitHubRepoRef>,
    updated_at: u64,
}

fn refs_from_output(output: &str) -> Result<GitHubRepoState, String> {
    let mut head = None;
    let mut branches = Vec::new();
    let mut tags = std::collections::BTreeMap::new();
    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        let (value, reference) = line
            .split_once('\t')
            .ok_or_else(|| "GitHub returned invalid repository refs".to_string())?;
        if reference == "HEAD" {
            if let Some(symbolic) = value.strip_prefix("ref: ") {
                let branch = symbolic
                    .strip_prefix("refs/heads/")
                    .ok_or_else(|| "GitHub returned an invalid default branch".to_string())?;
                head = Some(
                    clean_branch(Some(branch.to_string()))
                        .ok_or_else(|| "GitHub default branch is not supported".to_string())?,
                );
            }
            continue;
        }
        if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("GitHub returned an invalid repository ref".into());
        }
        if let Some(name) = reference.strip_prefix("refs/heads/") {
            let Some(name) = clean_branch(Some(name.to_string())) else {
                continue;
            };
            branches.push(GitHubRepoRef {
                name,
                commit: value.to_ascii_lowercase(),
            });
        } else if let Some(name) = reference.strip_prefix("refs/tags/") {
            let name = name.strip_suffix("^{}").unwrap_or(name);
            let Some(name) = clean_branch(Some(name.to_string())) else {
                continue;
            };
            tags.insert(name, value.to_ascii_lowercase());
        }
        if branches.len() + tags.len() > 10_000 {
            return Err("GitHub repository has too many refs".into());
        }
    }
    Ok(GitHubRepoState {
        head,
        branches,
        tags: tags
            .into_iter()
            .map(|(name, commit)| GitHubRepoRef { name, commit })
            .collect(),
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "System clock is invalid".to_string())?
            .as_secs(),
    })
}

#[derive(Deserialize)]
struct RawGitHubRepository {
    id: u64,
    full_name: String,
    private: bool,
    clone_url: String,
    html_url: String,
    default_branch: Option<String>,
    archived: bool,
    permissions: Option<GitHubPermissions>,
}

#[derive(Deserialize)]
struct GitHubPermissions {
    push: bool,
}

/// Credential-free repository metadata visible to the connected GitHub user.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository {
    id: String,
    full_name: String,
    private: bool,
    clone_url: String,
    web_url: String,
    default_branch: String,
    can_push: bool,
    archived: bool,
}

const REPO_FIELDS: &str =
    "{id,full_name,private,clone_url,html_url,default_branch,archived,permissions:{push:(.permissions.push // false)}}";

fn repository_metadata(raw: RawGitHubRepository) -> Result<GitHubRepository, String> {
    github_access::validate_repository(&raw.clone_url)?;
    let url = github_access::repository_url(&raw.clone_url)?;
    let slug = url.path().trim_matches('/').trim_end_matches(".git");
    if !slug.eq_ignore_ascii_case(&raw.full_name)
        || raw.html_url != format!("https://github.com/{}", raw.full_name)
        || raw.id == 0
    {
        return Err("GitHub returned inconsistent repository metadata".into());
    }
    let branch = clean_branch(raw.default_branch.clone())
        .ok_or_else(|| "GitHub repository has no valid default branch".to_string())?;
    Ok(GitHubRepository {
        id: raw.id.to_string(),
        full_name: raw.full_name,
        private: raw.private,
        clone_url: raw.clone_url,
        web_url: raw.html_url,
        default_branch: branch,
        can_push: raw.permissions.is_some_and(|permission| permission.push),
        archived: raw.archived,
    })
}

fn repository_json<T: serde::de::DeserializeOwned>(
    gh: &std::path::Path,
    path: &str,
    selection: &str,
) -> Result<T, String> {
    let output = github_access::run_cli(
        gh,
        &[
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            path,
            "--jq",
            selection,
        ],
    )?;
    if !output.status.success() {
        return Err(
            "GitHub repository access failed; check the connected account and retry".into(),
        );
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "GitHub returned invalid repository metadata".to_string())
}

fn list_repositories_with(gh: &std::path::Path) -> Result<Vec<GitHubRepository>, String> {
    let organization = github_access::organization()?;
    list_repositories_for_organization(gh, organization.as_deref())
}

fn list_repositories_for_organization(
    gh: &std::path::Path,
    organization: Option<&str>,
) -> Result<Vec<GitHubRepository>, String> {
    let mut repositories = std::collections::BTreeMap::new();
    for page in 1..=10 {
        let path = match organization {
            Some(organization) => format!("orgs/{organization}/repos?type=all&per_page=100&page={page}"),
            None => format!("user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page={page}"),
        };
        let batch: Vec<RawGitHubRepository> =
            repository_json(gh, &path, &format!("[.[] | {REPO_FIELDS}]"))?;
        let complete = batch.len() < 100;
        if batch.len() > 100 {
            return Err("GitHub returned an oversized repository page".into());
        }
        for raw in batch {
            if organization.is_some_and(|organization| {
                !raw.full_name
                    .split('/')
                    .next()
                    .is_some_and(|owner| owner.eq_ignore_ascii_case(organization))
            }) {
                continue;
            }
            let repository = repository_metadata(raw)?;
            repositories.insert(repository.full_name.to_ascii_lowercase(), repository);
        }
        if complete {
            return Ok(repositories.into_values().collect());
        }
    }
    Err("GitHub repository listing exceeded its safety limit".into())
}

/// List only repositories the current user can access in the managed organization.
#[tauri::command]
pub async fn list_github_repositories(
    state: State<'_, AppState>,
) -> Result<Vec<GitHubRepository>, String> {
    github_access::validate_workspace(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let gh = github_access::resolve_cli()
            .ok_or_else(|| "GitHub CLI is not installed".to_string())?;
        list_repositories_with(&gh)
    })
    .await
    .map_err(|_| "GitHub repository listing failed".to_string())?
}

/// Revalidate the selected repository before publishing its name/link to Buzz.
#[tauri::command]
pub async fn get_github_repository(
    clone_url: String,
    state: State<'_, AppState>,
) -> Result<GitHubRepository, String> {
    github_access::validate_workspace(&state)?;
    github_access::validate_repository(&clone_url)?;
    let url = github_access::repository_url(&clone_url)?;
    let slug = url
        .path()
        .trim_matches('/')
        .trim_end_matches(".git")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let gh = github_access::resolve_cli()
            .ok_or_else(|| "GitHub CLI is not installed".to_string())?;
        let raw = repository_json(&gh, &format!("repos/{slug}"), REPO_FIELDS)?;
        repository_metadata(raw)
    })
    .await
    .map_err(|_| "GitHub repository access check failed".to_string())?
}

/// Discover GitHub branches/tags using the same path-scoped Git authentication.
#[tauri::command]
pub async fn get_github_repository_state(
    clone_url: String,
    state: State<'_, AppState>,
) -> Result<GitHubRepoState, String> {
    github_access::validate_repository(&clone_url)?;
    let auth = build_git_clone_auth_config(&clone_url, &state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let output = run_git(
            &["ls-remote", "--symref", "--end-of-options", &clone_url],
            None,
            &auth,
        )?;
        refs_from_output(&output)
    })
    .await
    .map_err(|_| "GitHub repository check failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an explicitly selected private organization repository and per-user CLI auth"]
    fn private_github_repository_discovery_live() {
        let url = std::env::var("BUZZ_TEST_GITHUB_PRIVATE_REPO").expect("explicit private repo");
        let url = crate::github_access::repository_url(&url).expect("GitHub URL");
        let expected = url.path().trim_matches('/').trim_end_matches(".git");
        let gh = crate::managed_agents::resolve_command("gh").expect("per-user CLI");
        let repositories = list_repositories_for_organization(&gh, Some("Snap-Fusion-GmbH"))
            .expect("current account organization inventory");
        let repository = repositories
            .iter()
            .find(|repository| repository.full_name.eq_ignore_ascii_case(expected))
            .expect("the authorized private repository must appear in the picker");
        assert!(repository.private);
    }

    fn repository_fixture(owner: &str) -> serde_json::Value {
        serde_json::json!({
            "id": 6001, "full_name": format!("{owner}/private-demo"),
            "private": true,
            "clone_url": format!("https://github.com/{owner}/private-demo.git"),
            "html_url": format!("https://github.com/{owner}/private-demo"),
            "default_branch": "main", "archived": false, "permissions": {"push": true}
        })
    }

    #[cfg(unix)]
    fn fake_cli(body: &serde_json::Value, fail: bool) -> (tempfile::TempDir, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().expect("CLI fixture");
        let path = root.path().join("gh");
        let json = crate::github_access::shell_quote(&body.to_string());
        let exit = if fail { 1 } else { 0 };
        let script = format!(
            "#!/bin/sh\ncase \"$*\" in *'orgs/Snap-Fusion-GmbH/repos?'*) ;; *) exit 9 ;; esac\nprintf '%s' {json}\nexit {exit}\n"
        );
        std::fs::write(&path, script).expect("CLI script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .expect("executable");
        (root, path)
    }

    #[cfg(unix)]
    #[test]
    fn current_user_org_listing_keeps_only_consistent_authorized_metadata() {
        let body = serde_json::json!([
            repository_fixture("Snap-Fusion-GmbH"),
            repository_fixture("another-organization"),
        ]);
        let (_root, gh) = fake_cli(&body, false);
        let repositories = list_repositories_for_organization(&gh, Some("Snap-Fusion-GmbH"))
            .expect("authorized listing");
        assert_eq!(repositories.len(), 1);
        assert_eq!(repositories[0].full_name, "Snap-Fusion-GmbH/private-demo");
        assert!(repositories[0].private && repositories[0].can_push);
        let mut raw = repository_fixture("Snap-Fusion-GmbH");
        raw["clone_url"] =
            serde_json::json!("https://github.com/another-organization/private-demo.git");
        assert!(repository_metadata(serde_json::from_value(raw).expect("raw metadata")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn listing_failure_and_incomplete_pagination_do_not_become_empty_success() {
        let (_root, gh) = fake_cli(&serde_json::json!([]), true);
        assert!(list_repositories_for_organization(&gh, Some("Snap-Fusion-GmbH")).is_err());
        let body = serde_json::Value::Array(vec![repository_fixture("Snap-Fusion-GmbH"); 100]);
        let (_root, gh) = fake_cli(&body, false);
        let error = list_repositories_for_organization(&gh, Some("Snap-Fusion-GmbH"))
            .err()
            .expect("bounded pagination must fail, not publish partial inventory");
        assert!(error.contains("safety limit"));
        assert!(refs_from_output("not Git ref data").is_err());
    }

    #[test]
    fn refs_keep_the_symbolic_default_and_peeled_tag_commit() {
        let tip = "a".repeat(40);
        let tag = "b".repeat(40);
        let output = format!("ref: refs/heads/main\tHEAD\n{tip}\tHEAD\n{tip}\trefs/heads/main\n{tag}\trefs/tags/v1\n{tip}\trefs/tags/v1^{{}}\n");
        let state = refs_from_output(&output).unwrap();
        assert_eq!(state.head.as_deref(), Some("main"));
        assert_eq!(state.branches[0].commit, tip);
        assert_eq!(state.tags[0].commit, tip);
    }
}
