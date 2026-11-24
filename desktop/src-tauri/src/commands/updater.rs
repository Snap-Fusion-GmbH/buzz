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
mod linux_package_tests {
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

/// Maps a platform to its key in the new Buzz app's installer manifest, or
/// `None` when no installer is published for it.
///
/// On Linux a missing `APPIMAGE` variable only means "not an AppImage", so
/// the deb key also requires dpkg; a source build on another distro gets no
/// key instead of a package it cannot install.
fn installer_target_key(
    os: &str,
    arch: &str,
    is_appimage: bool,
    has_dpkg: bool,
) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        ("windows", "x86_64") => Some("windows-x64"),
        ("linux", "x86_64") if is_appimage => Some("linux-appimage"),
        ("linux", "x86_64") if has_dpkg => Some("linux-deb"),
        _ => None,
    }
}

/// Returns the running install's key in the new Buzz app's installer
/// manifest, or `None` when the frontend should link to the website instead.
#[tauri::command]
pub fn new_app_installer_target() -> Option<&'static str> {
    installer_target_key(
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::var_os("APPIMAGE").is_some(),
        std::path::Path::new("/usr/bin/dpkg").exists(),
    )
}

#[cfg(test)]
mod tests {
    use super::installer_target_key;

    #[test]
    fn installer_target_key_covers_each_shipped_target_and_nothing_else() {
        // (os, arch, is_appimage, has_dpkg, expected)
        let cases = [
            ("macos", "aarch64", false, false, Some("macos-arm64")),
            ("macos", "x86_64", false, false, Some("macos-x64")),
            ("windows", "x86_64", false, false, Some("windows-x64")),
            ("linux", "x86_64", true, false, Some("linux-appimage")),
            // An AppImage on a Debian host is still an AppImage.
            ("linux", "x86_64", true, true, Some("linux-appimage")),
            ("linux", "x86_64", false, true, Some("linux-deb")),
            // Source build on a distro without dpkg.
            ("linux", "x86_64", false, false, None),
            // No arm64 Linux or Windows installer is published.
            ("linux", "aarch64", true, true, None),
            ("windows", "aarch64", false, false, None),
            ("freebsd", "x86_64", false, true, None),
        ];
        for (os, arch, is_appimage, has_dpkg, expected) in cases {
            assert_eq!(
                installer_target_key(os, arch, is_appimage, has_dpkg),
                expected,
                "{os}/{arch} appimage={is_appimage} dpkg={has_dpkg}"
            );
        }
    }
}
