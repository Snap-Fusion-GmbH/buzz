/// Returns whether the running package can be updated in place by Tauri.
/// Debian updates use the system package manager and may require authorization.
#[tauri::command]
pub fn is_auto_update_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        supports_linux_package(
            tauri::utils::platform::bundle_type(),
            std::env::current_exe().ok().as_deref(),
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

#[cfg(target_os = "linux")]
fn supports_linux_package(
    bundle: Option<tauri::utils::config::BundleType>,
    executable: Option<&std::path::Path>,
) -> bool {
    use tauri::utils::config::BundleType;

    match bundle {
        Some(BundleType::AppImage) => true,
        Some(BundleType::Deb) => executable
            .and_then(std::path::Path::parent)
            .is_some_and(|parent| parent == std::path::Path::new("/usr/bin")),
        _ => false,
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::supports_linux_package;
    use std::path::Path;
    use tauri::utils::config::BundleType;

    #[test]
    fn linux_updates_match_the_running_installation() {
        assert!(!super::is_auto_update_supported());
        for (bundle, executable, expected) in [
            (Some(BundleType::Deb), Some("/usr/bin/buzz-desktop"), true),
            (
                Some(BundleType::Deb),
                Some("/home/member/.local/opt/buzz/current/usr/bin/buzz-desktop"),
                false,
            ),
            (Some(BundleType::Deb), None, false),
            (
                Some(BundleType::AppImage),
                Some("/home/member/Applications/Buzz.AppImage"),
                true,
            ),
            (Some(BundleType::Rpm), Some("/usr/bin/buzz-desktop"), false),
            (None, Some("/usr/bin/buzz-desktop"), false),
        ] {
            assert_eq!(
                supports_linux_package(bundle, executable.map(Path::new)),
                expected,
                "{executable:?}"
            );
        }
    }
}
