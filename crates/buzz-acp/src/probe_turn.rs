//! `buzz-acp probe-turn`: run one real prompt turn against an agent adapter
//! through the same handshake the runtime uses (initialize, session/new with
//! the runtime's system-prompt transport, optional model switch, prompt), so a
//! packaged build can be checked end to end before it ships.

use std::time::Duration;

use clap::Parser;

use crate::acp::{self, AcpClient, ModelSwitchMethod, StopReason};
use crate::config::{normalize_agent_args, AuthAgentArgs};

/// CLI args for `buzz-acp probe-turn`.
#[derive(Debug, Parser)]
#[command(
    name = "buzz-acp probe-turn",
    about = "Run one real prompt turn against the configured agent and report how it ended"
)]
pub struct ProbeTurnArgs {
    #[command(flatten)]
    pub agent: AuthAgentArgs,

    /// Prompt sent as the single user turn.
    #[arg(long, default_value = "Reply with the single word: pong")]
    pub prompt: String,

    /// System prompt delivered the way the runtime delivers it for this agent.
    #[arg(
        long,
        default_value = "You are a Buzz agent health probe. Answer briefly."
    )]
    pub system_prompt: String,

    /// Model to switch to before prompting (the agent default when omitted).
    #[arg(long)]
    pub model: Option<String>,

    /// Overall deadline for the whole probe, in seconds.
    #[arg(long, default_value_t = 180)]
    pub timeout_secs: u64,
}

/// Why a probe failed, kept distinct from a completed turn with a bad stop reason.
#[derive(Debug)]
struct ProbeFailure {
    stage: &'static str,
    message: String,
}

fn fail(stage: &'static str, error: impl std::fmt::Display) -> ProbeFailure {
    ProbeFailure {
        stage,
        message: error.to_string(),
    }
}

struct ProbeReport {
    agent_name: String,
    protocol_version: u32,
    stop_reason: StopReason,
}

async fn probe(
    client: &mut AcpClient,
    args: &ProbeTurnArgs,
    cwd: &str,
    deadline: Duration,
) -> Result<ProbeReport, ProbeFailure> {
    let init = client
        .initialize()
        .await
        .map_err(|e| fail("initialize", e))?;
    let protocol_version = init["protocolVersion"].as_u64().unwrap_or(1) as u32;
    let agent_name = crate::normalized_agent_name(&init);
    let transport = crate::pool::session_new_system_prompt(
        agent_name == "goose",
        protocol_version,
        &agent_name,
        Some(&args.system_prompt),
    );
    let session = client
        .session_new_full(cwd, vec![], transport, None)
        .await
        .map_err(|e| fail("session/new", e))?;
    if let Some(model) = args.model.as_deref() {
        match acp::resolve_model_switch_method(&session.raw, model) {
            Some(ModelSwitchMethod::ConfigOption {
                config_id,
                option_value,
            }) => client
                .session_set_config_option(&session.session_id, &config_id, &option_value)
                .await
                .map(drop),
            Some(ModelSwitchMethod::SetModel { model_id }) => client
                .session_set_model(&session.session_id, &model_id)
                .await
                .map(drop),
            None => {
                return Err(fail(
                    "model",
                    format!("agent does not offer model {model:?}"),
                ))
            }
        }
        .map_err(|e| fail("model", e))?;
    }
    let stop_reason = client
        .session_prompt_with_idle_timeout(&session.session_id, &args.prompt, deadline, deadline)
        .await
        .map_err(|e| fail("session/prompt", e))?;
    Ok(ProbeReport {
        agent_name,
        protocol_version,
        stop_reason,
    })
}

/// Run the probe and print one JSON line; exits non-zero unless the turn ended
/// with `end_turn`.
pub async fn run_probe_turn(args: ProbeTurnArgs) -> anyhow::Result<()> {
    let agent_args = normalize_agent_args(&args.agent.agent_command, args.agent.agent_args.clone());
    let cwd = crate::current_working_directory()?;
    let deadline = Duration::from_secs(args.timeout_secs.max(1));
    let mut client =
        match AcpClient::spawn(&args.agent.agent_command, &agent_args, &[], false).await {
            Ok(client) => client,
            Err(error) => {
                print_failure(&fail("spawn", error));
                std::process::exit(1);
            }
        };
    let outcome =
        match tokio::time::timeout(deadline, probe(&mut client, &args, &cwd, deadline)).await {
            Ok(outcome) => outcome,
            Err(_) => Err(fail("timeout", format!("no turn end within {deadline:?}"))),
        };
    client.shutdown().await;
    match outcome {
        Ok(report) => {
            let ok = report.stop_reason == StopReason::EndTurn;
            println!(
                "{}",
                serde_json::json!({
                    "ok": ok,
                    "agent": report.agent_name,
                    "protocolVersion": report.protocol_version,
                    "stopReason": format!("{:?}", report.stop_reason),
                })
            );
            if !ok {
                std::process::exit(1);
            }
            Ok(())
        }
        Err(failure) => {
            print_failure(&failure);
            std::process::exit(1);
        }
    }
}

fn print_failure(failure: &ProbeFailure) {
    println!(
        "{}",
        serde_json::json!({
            "ok": false,
            "stage": failure.stage,
            "error": failure.message,
        })
    );
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A claude-agent-acp stand-in speaking ACP v2 as 0.112 does: identity in
    /// `info`, a top-level `systemPrompt` rejected with -32602, and the prompt
    /// acknowledged with a `messageId` before an idle `state_update` ends it.
    const FAKE_CLAUDE_V2: &str = r#"
while read -r REQ; do
  ID=$(printf '%s' "$REQ" | sed -E 's/.*"id":([0-9]+).*/\1/')
  case "$REQ" in
    *'"method":"initialize"'*)
      echo '{"jsonrpc":"2.0","id":'"$ID"',"result":{"protocolVersion":2,"info":{"name":"@agentclientprotocol/claude-agent-acp","version":"0.112.0"}}}' ;;
    *'"method":"session/new"'*)
      if printf '%s' "$REQ" | grep -q '"systemPrompt":{"append"'; then
        echo '{"jsonrpc":"2.0","id":'"$ID"',"result":{"sessionId":"probe-session"}}'
      else
        echo '{"jsonrpc":"2.0","id":'"$ID"',"error":{"code":-32602,"message":"Invalid params"}}'
      fi ;;
    *'"method":"session/prompt"'*)
      echo '{"jsonrpc":"2.0","id":'"$ID"',"result":{"messageId":"m-1"}}'
      echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"probe-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"pong"}}}}'
      echo '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"probe-session","update":{"sessionUpdate":"state_update","state":"idle","stopReason":"end_turn"}}}' ;;
  esac
done
"#;

    #[tokio::test]
    async fn probe_completes_a_v2_claude_turn() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("buzz-acp-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create probe dir");
        let path = dir.join("claude-agent-acp");
        std::fs::write(&path, format!("#!/usr/bin/env bash\n{FAKE_CLAUDE_V2}\n"))
            .expect("write fake adapter");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod fake adapter");
        let command = path.to_str().expect("utf8 path").to_string();
        let args = ProbeTurnArgs::parse_from(["buzz-acp", "--agent-command", &command]);
        let mut client = AcpClient::spawn(&command, &[], &[], false)
            .await
            .expect("spawn fake adapter");

        let outcome = probe(&mut client, &args, "/", Duration::from_secs(5)).await;
        client.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);

        let report = outcome.unwrap_or_else(|f| panic!("{}: {}", f.stage, f.message));
        assert_eq!(report.agent_name, "@agentclientprotocol/claude-agent-acp");
        assert_eq!(report.protocol_version, 2);
        assert_eq!(report.stop_reason, StopReason::EndTurn);
    }
}
