//! Retire the Welcome-team agent instances that older builds provisioned.
//!
//! Starter personas and the Welcome Team are no longer shipped. Definition and
//! team retirement preserves user-customized records, but the three instances
//! created by the old onboarding kickoff still carry `team_id =
//! builtin-team:welcome`; once their definition is inactive the Agents view
//! groups them as unknown. Remove only those instances, after the retained
//! definition/team cleanup has made the retirement durable.

use std::path::Path;

use crate::managed_agents::ManagedAgentRecord;

pub(super) const RETIRED_WELCOME_TEAM_ID: &str = "builtin-team:welcome";

/// Remove instances bound to the retired Welcome Team, returning their pubkeys.
pub(super) fn remove_retired_welcome_agents_in_dir(base_dir: &Path) -> Result<Vec<String>, String> {
    let path = base_dir.join("managed-agents.json");
    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read managed-agents.json: {e}"))?;
    let mut records: Vec<ManagedAgentRecord> = serde_json::from_str(&content)
        .map_err(|e| format!("failed to parse managed-agents.json: {e}"))?;

    let retired: Vec<String> = records
        .iter()
        .filter(|record| record.team_id.as_deref() == Some(RETIRED_WELCOME_TEAM_ID))
        .map(|record| record.pubkey.clone())
        .filter(|pubkey| !pubkey.is_empty())
        .collect();
    if retired.is_empty() {
        return Ok(retired);
    }

    let bak_path = crate::util::resolved_backup_path(
        &path,
        "managed-agents.json.pre-retired-welcome-agents.bak",
    );
    crate::util::create_restricted_backup_once(&bak_path, content.as_bytes())
        .map_err(|e| format!("failed to write retired-welcome backup: {e}"))?;

    records.retain(|record| record.team_id.as_deref() != Some(RETIRED_WELCOME_TEAM_ID));
    let payload = serde_json::to_vec_pretty(&records)
        .map_err(|e| format!("failed to serialize managed-agents.json: {e}"))?;
    crate::managed_agents::atomic_write_json_restricted(&path, &payload)?;
    Ok(retired)
}

/// Remove the agent keys and enqueue tombstones after their records are gone.
pub(super) fn finish_retired_welcome_agents(app: &tauri::AppHandle, pubkeys: &[String]) {
    use tauri::Manager as _;
    let state = app.state::<crate::app_state::AppState>();
    for pubkey in pubkeys {
        crate::managed_agents::delete_agent_key(pubkey);
        crate::commands::tombstone_managed_agent_pending(app, &state, pubkey);
    }
}

#[cfg(test)]
mod tests {
    use super::remove_retired_welcome_agents_in_dir;

    fn record(pubkey: &str, team_id: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "pubkey": pubkey,
            "name": pubkey,
            "persona_id": "builtin:fizz",
            "team_id": team_id,
            "relay_url": "ws://localhost:3000",
            "acp_command": "buzz-acp",
            "agent_command": "buzz-agent",
            "agent_args": [],
            "mcp_command": "",
            "turn_timeout_seconds": 300,
            "system_prompt": null,
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        })
    }

    #[test]
    fn removes_only_welcome_team_instances() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("managed-agents.json");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!([
                record("welcome-fizz", Some("builtin-team:welcome")),
                record("welcome-honey", Some("builtin-team:welcome")),
                record("user-agent", None),
                record("other-team", Some("user-team"))
            ]))
            .unwrap(),
        )
        .unwrap();

        let removed = remove_retired_welcome_agents_in_dir(dir.path()).unwrap();
        assert_eq!(removed, vec!["welcome-fizz", "welcome-honey"]);

        let remaining: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let names: Vec<&str> = remaining
            .iter()
            .filter_map(|record| record["pubkey"].as_str())
            .collect();
        assert_eq!(names, vec!["user-agent", "other-team"]);
    }

    #[test]
    fn is_a_noop_when_no_retired_instances_exist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("managed-agents.json");
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&serde_json::json!([record("user-agent", None)])).unwrap(),
        )
        .unwrap();

        assert!(remove_retired_welcome_agents_in_dir(dir.path())
            .unwrap()
            .is_empty());
        assert!(!dir
            .path()
            .join("managed-agents.json.pre-retired-welcome-agents.bak")
            .exists());
    }
}
