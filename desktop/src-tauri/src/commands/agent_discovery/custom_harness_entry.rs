//! The catalog entry returned after saving a user-defined harness.

use crate::managed_agents::custom_harnesses::HarnessDefinition;
use crate::managed_agents::{
    AcpAvailabilityStatus, AcpRuntimeCatalogEntry, AuthStatus, HarnessSource,
};

/// Resolve a just-saved custom harness into the catalog entry the UI shows.
pub(super) fn saved_custom_harness_entry(definition: HarnessDefinition) -> AcpRuntimeCatalogEntry {
    // Resolve availability for the returned catalog entry.
    let (availability, command_opt, binary_path) =
        match crate::managed_agents::find_command(&definition.command) {
            Some(path) => (
                AcpAvailabilityStatus::Available,
                Some(definition.command.clone()),
                Some(path.display().to_string()),
            ),
            None => (AcpAvailabilityStatus::NotInstalled, None, None),
        };

    let default_args =
        crate::managed_agents::normalize_agent_args(&definition.command, definition.args.clone());

    AcpRuntimeCatalogEntry {
        id: definition.id,
        label: definition.label,
        avatar_url: String::new(),
        availability,
        command: command_opt,
        binary_path,
        default_args,
        mcp_command: None,
        model_env_var: None,
        provider_env_var: None,
        thinking_env_var: None,
        effort_canonical_values: None,
        max_tokens_env_var: None,
        context_limit_env_var: None,
        max_rounds_env_var: None,
        install_hint: definition.install_hint,
        install_instructions_url: definition.install_instructions_url,
        cli_install_command: None,
        can_auto_install: false,
        requires_external_cli: false,
        underlying_cli_path: None,
        node_required: false,
        auth_status: AuthStatus::NotApplicable,
        login_hint: None,
        source: HarnessSource::Custom,
        definition_env: definition.env,
        max_parallelism: crate::managed_agents::harness_max_parallelism(&definition.command),
    }
}
