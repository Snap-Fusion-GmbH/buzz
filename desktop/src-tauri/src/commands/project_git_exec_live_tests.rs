use super::{build_github_auth_config, run_git};
use std::{io::Write, os::unix::fs::OpenOptionsExt, path::Path};

fn save_receipt(path: &Path, value: &serde_json::Value, initial: bool) -> Result<(), String> {
    let target = if initial {
        path.to_path_buf()
    } else {
        path.with_extension(format!("next-{}", uuid::Uuid::new_v4().simple()))
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&target)
        .map_err(|error| error.to_string())?;
    serde_json::to_writer_pretty(&mut file, value).map_err(|error| error.to_string())?;
    file.write_all(b"\n").map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if !initial {
        std::fs::rename(&target, path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[test]
#[ignore = "requires explicit private organization repository and durable receipt path"]
fn private_github_round_trip() {
    let clone_url = std::env::var("BUZZ_TEST_GITHUB_PRIVATE_REPO").expect("explicit test repo");
    let receipt_path = std::path::PathBuf::from(
        std::env::var("BUZZ_TEST_GITHUB_RECEIPT").expect("explicit durable receipt"),
    );
    let url = crate::github_access::repository_url(&clone_url).expect("HTTPS GitHub repository");
    assert_eq!(
        url.path_segments().and_then(|mut parts| parts.next()),
        Some("Snap-Fusion-GmbH")
    );
    let slug = url.path().trim_matches('/').trim_end_matches(".git");
    let gh = crate::managed_agents::resolve_command("gh").expect("per-user GitHub CLI");
    let private = crate::github_access::run_cli(
        &gh,
        &[
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            &format!("repos/{slug}"),
            "--jq",
            ".private",
        ],
    )
    .expect("private-repository metadata");
    assert!(
        private.status.success(),
        "the user's account must have repository access"
    );
    assert_eq!(String::from_utf8_lossy(&private.stdout).trim(), "true");
    let auth = build_github_auth_config(&clone_url, Some(&gh)).expect("real GitHub authentication");
    let branch = format!("test/buzz-private-github-{}", uuid::Uuid::new_v4().simple());
    let reference = format!("refs/heads/{branch}");
    let mut receipt = serde_json::json!({
        "repository": clone_url, "branch": branch, "state": "started",
        "verified": false, "branch_deleted": false,
    });
    save_receipt(&receipt_path, &receipt, true).expect("durable initial journal");
    let directory = tempfile::tempdir().expect("private temporary checkout");
    let checkout = directory.path().join("checkout");
    let checkout_text = checkout.to_str().expect("UTF-8 checkout");
    run_git(
        &[
            "clone",
            "--filter=blob:none",
            "--",
            &clone_url,
            checkout_text,
        ],
        None,
        &auth,
    )
    .expect("authenticated private clone");
    run_git(&["checkout", "-b", &branch], Some(&checkout), &auth).expect("task-owned branch");
    let file = format!(
        "buzz-private-github-test-{}.txt",
        uuid::Uuid::new_v4().simple()
    );
    std::fs::write(
        checkout.join(&file),
        "Task-owned Buzz private GitHub transport verification.\n",
    )
    .expect("fixture file");
    run_git(&["add", "--", &file], Some(&checkout), &auth).expect("stage fixture");
    run_git(
        &[
            "-c",
            "user.name=Buzz GitHub verification",
            "-c",
            "user.email=buzz-github-test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "-s",
            "-m",
            "test: verify private GitHub transport on task-owned branch",
        ],
        Some(&checkout),
        &auth,
    )
    .expect("fixture commit");
    let commit = run_git(&["rev-parse", "HEAD"], Some(&checkout), &auth)
        .expect("expected commit")
        .trim()
        .to_string();
    receipt["expected_commit"] = serde_json::json!(commit);
    receipt["state"] = serde_json::json!("ready-to-push");
    save_receipt(&receipt_path, &receipt, false).expect("persist exact ref before remote write");

    let verification = crate::commands::project_git_push::push_project_local_repository_blocking(
        &checkout,
        clone_url.clone(),
        Some(branch.clone()),
        None,
        &auth,
    )
    .and_then(|result| {
        if result.commit != commit {
            return Err("The production pusher reported a different commit".to_string());
        }
        let output = run_git(
            &["ls-remote", "--heads", &clone_url, &reference],
            None,
            &auth,
        )?;
        if !output
            .lines()
            .any(|line| line == format!("{commit}\t{reference}"))
        {
            return Err("Private GitHub commit was not read back".to_string());
        }
        Ok(())
    });

    // Reconcile an ambiguous push before cleanup; never delete a changed ref.
    let cleanup = run_git(
        &["ls-remote", "--heads", &clone_url, &reference],
        None,
        &auth,
    )
    .and_then(|output| {
        if output.trim().is_empty() {
            return Ok(());
        }
        if output.trim() != format!("{commit}\t{reference}") {
            return Err("Task-owned remote branch changed; manual reconciliation required".into());
        }
        run_git(
            &[
                "push",
                &format!("--force-with-lease={reference}:{commit}"),
                "--end-of-options",
                &clone_url,
                &format!(":{reference}"),
            ],
            Some(&checkout),
            &auth,
        )?;
        let output = run_git(
            &["ls-remote", "--heads", &clone_url, &reference],
            None,
            &auth,
        )?;
        if !output.trim().is_empty() {
            return Err("Task-owned branch cleanup is still pending".into());
        }
        Ok(())
    });
    receipt["verified"] = serde_json::json!(verification.is_ok());
    receipt["branch_deleted"] = serde_json::json!(cleanup.is_ok());
    receipt["state"] = serde_json::json!(if cleanup.is_err() {
        "cleanup-required"
    } else if verification.is_ok() {
        "complete"
    } else {
        "verification-failed"
    });
    save_receipt(&receipt_path, &receipt, false).expect("durable final journal");
    verification.expect("private clone/commit/production push/readback");
    cleanup.expect("lease-safe task-owned branch cleanup");
}
