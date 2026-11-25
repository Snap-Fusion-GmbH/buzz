//! The vendor installer a catalog entry shows for consent.

#[test]
fn catalog_entries_name_the_vendor_installer_install_would_run() {
    // First-run agent setup shows this command before the user consents, so
    // it must be exactly the step `install_acp_runtime` runs first.
    for id in ["claude", "codex"] {
        let runtime = super::known_acp_runtime_exact(id).expect("built-in runtime");
        let entry = super::discover_acp_runtime_phase1(runtime, false).entry;
        assert!(entry.cli_install_command.is_some(), "{id} has an installer");
        assert_eq!(
            entry.cli_install_command.as_deref(),
            runtime.cli_install_commands_for_os().first().copied(),
            "{id}"
        );
    }
    let bundled = super::known_acp_runtime_exact("buzz-agent").expect("bundled runtime");
    let entry = super::discover_acp_runtime_phase1(bundled, false).entry;
    assert_eq!(entry.cli_install_command, None);
}
