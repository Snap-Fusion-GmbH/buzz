//! Whether an ACP runtime install may run the vendor's CLI installer.
//!
//! Every `cli_install_commands` entry today is a vendor curl-pipe script, so it
//! only runs for an install the user explicitly started. Adapter-only installs
//! (Buzz's automatic first-run setup) never fall back to it, even if the CLI
//! disappeared after the runtime was probed.

use crate::managed_agents::KnownAcpRuntime;

#[derive(Debug, PartialEq, Eq)]
enum CliInstallDecision {
    /// The CLI is present: go straight to the adapter.
    Skip,
    /// Run the vendor CLI installer: the user asked for a full install.
    Run,
    /// The CLI is missing but only an adapter install was authorized.
    Refuse,
}

fn decide(cli_missing: bool, adapter_only: bool) -> CliInstallDecision {
    match (cli_missing, adapter_only) {
        (false, _) => CliInstallDecision::Skip,
        (true, false) => CliInstallDecision::Run,
        (true, true) => CliInstallDecision::Refuse,
    }
}

/// `Ok(true)` when the install must run the vendor CLI installer first,
/// `Ok(false)` when the CLI is present, and an error when the CLI is missing
/// but only an adapter install was authorized.
pub(super) fn vendor_cli_install_needed(
    runtime: &KnownAcpRuntime,
    cli: &str,
    adapter_only: bool,
) -> Result<bool, String> {
    let cli_missing = crate::managed_agents::resolve_command(cli).is_none();
    match decide(cli_missing, adapter_only) {
        CliInstallDecision::Skip => Ok(false),
        CliInstallDecision::Run => Ok(true),
        CliInstallDecision::Refuse => Err(format!(
            "{} is not installed. Install it first, then retry.",
            runtime.label
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{decide, vendor_cli_install_needed, CliInstallDecision};

    #[test]
    fn only_an_explicit_full_install_runs_a_vendor_installer() {
        for (cli_missing, adapter_only, expected) in [
            (false, false, CliInstallDecision::Skip),
            (false, true, CliInstallDecision::Skip),
            (true, false, CliInstallDecision::Run),
            (true, true, CliInstallDecision::Refuse),
        ] {
            assert_eq!(decide(cli_missing, adapter_only), expected);
        }
    }

    #[test]
    fn an_adapter_only_install_refuses_a_missing_cli() {
        let runtime = crate::managed_agents::known_acp_runtime_exact("claude").expect("claude");
        let absent = "buzz-test-cli-that-does-not-exist";
        let refused = vendor_cli_install_needed(runtime, absent, true).expect_err("refused");
        assert!(refused.contains("not installed"), "{refused}");
        assert_eq!(vendor_cli_install_needed(runtime, absent, false), Ok(true));
    }
}
