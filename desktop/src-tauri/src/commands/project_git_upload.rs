use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use super::project_git::first_output_line;
use super::project_git::normalize_branch_option;
use super::project_git_exec::{
    build_git_auth_config, run_git, validate_workspace_clone_url, GitAuthConfig,
};
use super::project_git_push::push_project_local_repository_blocking;
use super::project_git_workflow::clone_project_repository_blocking;
use super::project_repo_paths::find_local_repo_dir;
use crate::app_state::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use nostr::{EventBuilder, JsonUtil, Keys, Kind, Tag};
use sha2::{Digest, Sha256};

static PROJECT_UPLOAD_LOCK: Mutex<()> = Mutex::new(());

fn push_authorization_header(clone_url: &str, keys: &Keys) -> Result<String, String> {
    let body = b"0000";
    let payload = hex::encode(Sha256::digest(body));
    let tags = vec![
        Tag::parse(["u", clone_url]).map_err(|error| error.to_string())?,
        Tag::parse(["method", "POST"]).map_err(|error| error.to_string())?,
        Tag::parse(["nonce", &uuid::Uuid::new_v4().to_string()])
            .map_err(|error| error.to_string())?,
        Tag::parse(["payload", &payload]).map_err(|error| error.to_string())?,
    ];
    let event = EventBuilder::new(Kind::Custom(27235), "")
        .tags(tags)
        .sign_with_keys(keys)
        .map_err(|error| format!("failed to sign push authorization: {error}"))?;
    Ok(format!(
        "Authorization: Nostr {}",
        BASE64.encode(event.as_json())
    ))
}

struct UploadDestinations {
    pending: Vec<(PathBuf, PathBuf, String)>,
    selected_names: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ProjectRepoUploadResult {
    pub branch: String,
    pub commit: String,
    pub files: Vec<String>,
    pub path: String,
}

fn uploaded_file_name(path: &Path) -> Result<String, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or_else(|| "Selected files must have valid names.".to_string())?;
    if name.eq_ignore_ascii_case(".git") {
        return Err(".git cannot be added to a repository.".to_string());
    }
    Ok(name.to_string())
}

fn prepare_upload_destinations(
    repo_dir: &Path,
    sources: &[PathBuf],
) -> Result<UploadDestinations, String> {
    let mut destinations = Vec::with_capacity(sources.len());
    let mut names = HashSet::with_capacity(sources.len());
    for source in sources {
        let name = uploaded_file_name(source)?;
        if !names.insert(name.clone()) {
            return Err(format!("More than one selected file is named {name}."));
        }
        let metadata = source
            .symlink_metadata()
            .map_err(|error| format!("Cannot read {name}: {error}"))?;
        if !metadata.is_file() {
            return Err(format!("{name} is not a regular file."));
        }
        let destination = repo_dir.join(&name);
        if destination.exists() || destination.symlink_metadata().is_ok() {
            if files_equal(source, &destination)? {
                continue;
            }
            return Err(format!(
                "{name} already exists in this repository with different contents. Rename the selected file and try again."
            ));
        }
        destinations.push((source.clone(), destination, name));
    }
    Ok(UploadDestinations {
        pending: destinations,
        selected_names: names.into_iter().collect(),
    })
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    use std::io::Read;

    if left.metadata().map_err(|error| error.to_string())?.len()
        != right.metadata().map_err(|error| error.to_string())?.len()
    {
        return Ok(false);
    }
    let mut left = std::fs::File::open(left).map_err(|error| error.to_string())?;
    let mut right = std::fs::File::open(right).map_err(|error| error.to_string())?;
    let mut left_buffer = [0; 64 * 1024];
    let mut right_buffer = [0; 64 * 1024];
    loop {
        let left_count = left
            .read(&mut left_buffer)
            .map_err(|error| error.to_string())?;
        let right_count = right
            .read(&mut right_buffer)
            .map_err(|error| error.to_string())?;
        if left_count != right_count || left_buffer[..left_count] != right_buffer[..right_count] {
            return Ok(false);
        }
        if left_count == 0 {
            return Ok(true);
        }
    }
}

fn upload_project_files_blocking(
    repos_dir: Option<&str>,
    project_dtag: &str,
    clone_url: &str,
    default_branch: Option<&str>,
    sources: &[PathBuf],
    private_key_nsec: &str,
    auth: &GitAuthConfig,
) -> Result<ProjectRepoUploadResult, String> {
    let _operation_guard = PROJECT_UPLOAD_LOCK
        .lock()
        .map_err(|_| "The repository upload lock is unavailable.".to_string())?;
    if sources.is_empty() {
        return Err("Select at least one file.".to_string());
    }
    let repo_dir = match find_local_repo_dir(repos_dir, project_dtag, Some(clone_url))? {
        Some(path) => path,
        None => PathBuf::from(
            clone_project_repository_blocking(
                repos_dir,
                project_dtag,
                clone_url,
                default_branch,
                auth,
            )?
            .path,
        ),
    };
    let status = run_git(&["status", "--porcelain"], Some(&repo_dir), auth)?;
    if !status.trim().is_empty() {
        return Err(
            "This checkout has uncommitted changes. Commit, stash, or discard them before adding files."
                .to_string(),
        );
    }
    let branch = run_git(&["branch", "--show-current"], Some(&repo_dir), auth)
        .ok()
        .and_then(|output| first_output_line(&output))
        .and_then(|value| normalize_branch_option(Some(&value)))
        .or_else(|| default_branch.map(str::to_string))
        .ok_or_else(|| "The repository does not have a branch selected.".to_string())?;
    let signing_keys =
        Keys::parse(private_key_nsec).map_err(|error| format!("invalid signing key: {error}"))?;
    let UploadDestinations {
        pending: destinations,
        selected_names: names,
    } = prepare_upload_destinations(&repo_dir, sources)?;
    if destinations.is_empty() {
        let current_commit = run_git(&["rev-parse", "HEAD"], Some(&repo_dir), auth)
            .ok()
            .and_then(|output| first_output_line(&output));
        let sync = super::project_git::compare_local_remote_status(
            &repo_dir,
            clone_url,
            Some(&branch),
            None,
            auth,
        );
        if !sync.can_push
            && sync.push_block_reason.as_deref() == Some("Local branch is already pushed.")
        {
            return Ok(ProjectRepoUploadResult {
                branch,
                commit: sync.local_head.or(current_commit).ok_or_else(|| {
                    "The selected files are already in the repository.".to_string()
                })?,
                files: names,
                path: repo_dir.display().to_string(),
            });
        }
        let pushed = push_project_local_repository_blocking(
            &repo_dir,
            clone_url.to_string(),
            Some(branch.clone()),
            None,
            auth,
        )?;
        return Ok(ProjectRepoUploadResult {
            branch: pushed.branch,
            commit: pushed.commit,
            files: names,
            path: repo_dir.display().to_string(),
        });
    }
    let new_names = destinations
        .iter()
        .map(|(_, _, name)| name.clone())
        .collect::<Vec<_>>();

    for (source, destination, name) in &destinations {
        if let Err(error) = std::fs::copy(source, destination) {
            for (_, destination, _) in &destinations {
                let _ = std::fs::remove_file(destination);
            }
            return Err(format!(
                "Could not copy {name} into the repository: {error}"
            ));
        }
    }

    let name_refs = new_names.iter().map(String::as_str).collect::<Vec<_>>();
    let mut add_args = vec!["add", "--"];
    add_args.extend(name_refs.iter().copied());
    if let Err(error) = run_git(&add_args, Some(&repo_dir), auth) {
        for (_, destination, _) in &destinations {
            let _ = std::fs::remove_file(destination);
        }
        let _ = run_git(&["reset", "--", "."], Some(&repo_dir), auth);
        return Err(error);
    }

    let message = if new_names.len() == 1 {
        format!("Add {}", new_names[0])
    } else {
        format!("Add {} files", new_names.len())
    };
    let email = format!("{}@users.noreply.buzz", signing_keys.public_key().to_hex());
    run_git(
        &[
            "-c",
            "user.name=Buzz User",
            "-c",
            &format!("user.email={email}"),
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--only",
            "-m",
            &message,
            "--",
        ]
        .into_iter()
        .chain(name_refs.iter().copied())
        .collect::<Vec<_>>(),
        Some(&repo_dir),
        auth,
    )?;
    let commit = run_git(&["rev-parse", "HEAD"], Some(&repo_dir), auth)
        .ok()
        .and_then(|output| first_output_line(&output))
        .ok_or_else(|| "Could not resolve the new upload commit.".to_string())?;
    let pushed = push_project_local_repository_blocking(
        &repo_dir,
        clone_url.to_string(),
        Some(branch.clone()),
        None,
        auth,
    )
    .or_else(|error| {
        if error.contains("HTTP 401")
            || error.contains("HTTP 403")
            || error.contains("missing Authorization")
        {
            let header = push_authorization_header(clone_url, &signing_keys)?;
            run_git(
                &[
                    "-c",
                    &format!("http.extraHeader={header}"),
                    "push",
                    "--end-of-options",
                    "origin",
                    format!("HEAD:{branch}").as_str(),
                ],
                Some(&repo_dir),
                auth,
            )
            .map(|_| super::project_git::ProjectRepoPushResult {
                pushed: true,
                message: format!("Pushed {branch} to remote."),
                branch: branch.clone(),
                commit: commit.clone(),
                merge_base: None,
            })
        } else {
            Err(error)
        }
    })
    .map_err(|error| {
        format!(
            "The files were committed locally as {commit}, but the push failed: {error}. Open the repository in Terminal to resolve it, then push again."
        )
    })?;

    Ok(ProjectRepoUploadResult {
        branch: pushed.branch,
        commit,
        files: names,
        path: repo_dir.display().to_string(),
    })
}

/// Select local files, commit them as one change, and push the Buzz repository.
/// Existing files and dirty checkouts are rejected before any copy occurs.
#[tauri::command]
pub async fn pick_and_upload_project_files(
    repos_dir: Option<String>,
    project_dtag: String,
    clone_url: String,
    default_branch: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ProjectRepoUploadResult>, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    let auth = build_git_auth_config(&state)?;
    let pubkey = state.signing_keys()?.public_key().to_hex();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let Some(paths) = rx.await.map_err(|_| "dialog cancelled".to_string())? else {
        return Ok(None);
    };
    let sources = paths
        .into_iter()
        .map(|path| {
            path.as_path()
                .map(Path::to_path_buf)
                .ok_or_else(|| "The file picker returned an invalid path.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if sources.is_empty() {
        return Ok(None);
    }

    tauri::async_runtime::spawn_blocking(move || {
        upload_project_files_blocking(
            repos_dir.as_deref(),
            &project_dtag,
            &clone_url,
            default_branch.as_deref(),
            &sources,
            &pubkey,
            &auth,
        )
        .map(Some)
    })
    .await
    .map_err(|error| format!("project file upload task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::upload_project_files_blocking;
    use crate::commands::project_git_exec::{build_test_git_auth_config, run_git};
    use std::path::{Path, PathBuf};

    struct Fixture {
        root: tempfile::TempDir,
        checkout: PathBuf,
        source: PathBuf,
        remote: PathBuf,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().expect("create fixture root");
        let checkout = root.path().join("checkout");
        let source = root.path().join("source.txt");
        let remote = root.path().join("remote.git");
        let auth = build_test_git_auth_config().expect("git auth");
        run_git(
            &["init", "--initial-branch=main", "--bare", "--"]
                .into_iter()
                .chain(remote.to_str())
                .collect::<Vec<_>>(),
            None,
            &auth,
        )
        .expect("create remote");
        std::fs::write(&source, "new document\n").expect("source fixture");
        Fixture {
            root,
            checkout,
            source,
            remote,
        }
    }

    fn clone(fixture: &Fixture) {
        let auth = build_test_git_auth_config().expect("git auth");
        run_git(
            &[
                "clone",
                "--end-of-options",
                fixture.remote.to_str().expect("remote path"),
                fixture.checkout.to_str().expect("checkout path"),
            ],
            None,
            &auth,
        )
        .expect("clone empty remote");
    }

    fn upload(fixture: &Fixture, sources: &[PathBuf]) -> Result<String, String> {
        let auth = build_test_git_auth_config().expect("git auth");
        upload_project_files_blocking(
            fixture.root.path().to_str(),
            "checkout",
            fixture.remote.to_str().expect("remote path"),
            Some("main"),
            sources,
            &"a".repeat(64),
            &auth,
        )
        .map(|result| result.commit)
    }

    fn status(path: &Path) -> String {
        let auth = build_test_git_auth_config().expect("git auth");
        run_git(&["status", "--porcelain"], Some(path), &auth).expect("git status")
    }

    fn head(path: &Path) -> String {
        let auth = build_test_git_auth_config().expect("git auth");
        run_git(&["rev-parse", "HEAD"], Some(path), &auth)
            .expect("git head")
            .trim()
            .to_string()
    }

    #[test]
    fn selected_files_are_committed_and_pushed_to_an_empty_repository() {
        let fixture = fixture();
        clone(&fixture);
        let commit = upload(&fixture, &[fixture.source.clone()]).expect("upload");
        let auth = build_test_git_auth_config().expect("git auth");
        let remote_commit =
            run_git(&["rev-parse", "main"], Some(&fixture.remote), &auth).expect("remote commit");
        assert_eq!(remote_commit.trim(), commit);
        assert_eq!(
            std::fs::read_to_string(fixture.checkout.join("source.txt")).expect("uploaded file"),
            "new document\n"
        );
        assert!(status(&fixture.checkout).is_empty());
    }

    #[test]
    fn an_existing_destination_leaves_the_checkout_untouched() {
        let fixture = fixture();
        clone(&fixture);
        upload(&fixture, &[fixture.source.clone()]).expect("first upload");
        std::fs::write(&fixture.source, "replacement\n").expect("change source");
        let error = upload(&fixture, &[fixture.source.clone()]).expect_err("conflict");
        assert!(error.contains("already exists"));
        assert!(status(&fixture.checkout).is_empty());
        assert_eq!(
            std::fs::read_to_string(fixture.checkout.join("source.txt")).expect("original file"),
            "new document\n"
        );
    }

    #[test]
    fn a_dirty_checkout_is_not_changed_or_committed() {
        let fixture = fixture();
        clone(&fixture);
        std::fs::write(fixture.checkout.join("work-in-progress.txt"), "keep me\n")
            .expect("local work");
        let error = upload(&fixture, &[fixture.source.clone()]).expect_err("dirty checkout");
        assert!(error.contains("uncommitted changes"));
        assert!(!fixture.checkout.join("source.txt").exists());
        assert_eq!(status(&fixture.checkout), "?? work-in-progress.txt\n");
    }

    #[test]
    fn retrying_unchanged_files_pushes_the_preserved_local_commit() {
        let fixture = fixture();
        clone(&fixture);
        let original_remote = fixture.root.path().join("unavailable-remote.git");
        let auth = build_test_git_auth_config().expect("git auth");
        run_git(
            &[
                "remote",
                "set-url",
                "origin",
                original_remote.to_str().expect("path"),
            ],
            Some(&fixture.checkout),
            &auth,
        )
        .expect("break remote");
        let error = upload_project_files_blocking(
            fixture.root.path().to_str(),
            "checkout",
            original_remote.to_str().expect("path"),
            Some("main"),
            &[fixture.source.clone()],
            &"a".repeat(64),
            &auth,
        )
        .expect_err("push must fail");
        assert!(error.contains("committed locally"));
        let local_commit = head(&fixture.checkout);
        run_git(
            &[
                "remote",
                "set-url",
                "origin",
                fixture.remote.to_str().expect("path"),
            ],
            Some(&fixture.checkout),
            &auth,
        )
        .expect("restore remote");
        let retried_commit = upload(&fixture, &[fixture.source.clone()]).expect("retry");
        assert_eq!(retried_commit, local_commit);
        assert_eq!(
            run_git(&["rev-parse", "main"], Some(&fixture.remote), &auth)
                .expect("remote commit")
                .trim(),
            local_commit
        );
    }

    #[test]
    fn selecting_an_already_pushed_file_does_not_create_another_commit() {
        let fixture = fixture();
        clone(&fixture);
        let commit = upload(&fixture, &[fixture.source.clone()]).expect("upload");
        assert_eq!(
            upload(&fixture, &[fixture.source.clone()]).expect("idempotent retry"),
            commit
        );
        let auth = build_test_git_auth_config().expect("git auth");
        assert_eq!(
            run_git(
                &["rev-list", "--count", "main"],
                Some(&fixture.remote),
                &auth
            )
            .expect("remote history")
            .trim(),
            "1"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_relay_401_retries_with_a_preemptive_signed_header() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = fixture();
        clone(&fixture);
        let git = build_test_git_auth_config().expect("git auth");
        let real_git = git.git_path.clone();
        let log = fixture.root.path().join("git-arguments");
        let script = fixture.root.path().join("git-with-auth-check");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\nfor argument in \"$@\"; do\n  case \"$argument\" in\n    http.extraHeader=Authorization:*)\n      exec '{}' \"$@\"\n      ;;\n  esac\ndone\nif [ \"$1\" = push ]; then\n  echo 'RPC failed; HTTP 401 missing Authorization header' >&2\n  exit 1\nfi\nexec '{}' \"$@\"\n",
                log.display(),
                real_git.display(),
                real_git.display(),
            ),
        )
        .expect("fake git");
        let mut permissions = std::fs::metadata(&script)
            .expect("script metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&script, permissions).expect("script executable");
        let mut auth = build_test_git_auth_config().expect("git auth");
        auth.git_path = script;
        let commit = upload_project_files_blocking(
            fixture.root.path().to_str(),
            "checkout",
            fixture.remote.to_str().expect("remote path"),
            Some("main"),
            &[fixture.source.clone()],
            &"a".repeat(64),
            &auth,
        )
        .expect("authenticated retry");
        assert_eq!(commit.commit, head(&fixture.checkout));
        let arguments = std::fs::read_to_string(log).expect("argument log");
        assert!(arguments.contains("http.extraHeader=Authorization: Nostr "));
        assert!(arguments.contains("push"));
    }

    #[test]
    fn more_than_one_hundred_files_are_committed_in_one_upload() {
        let fixture = fixture();
        clone(&fixture);
        let sources = (0..101)
            .map(|index| {
                let source = fixture.root.path().join(format!("bulk-{index}.txt"));
                std::fs::write(&source, format!("file {index}\n")).expect("bulk fixture");
                source
            })
            .collect::<Vec<_>>();
        upload(&fixture, &sources).expect("bulk upload");
        let auth = build_test_git_auth_config().expect("git auth");
        assert_eq!(
            run_git(
                &["show", "--format=%s", "--no-patch", "HEAD"],
                Some(&fixture.checkout),
                &auth,
            )
            .expect("commit subject")
            .trim(),
            "Add 101 files"
        );
        assert!(status(&fixture.checkout).is_empty());
    }
}
