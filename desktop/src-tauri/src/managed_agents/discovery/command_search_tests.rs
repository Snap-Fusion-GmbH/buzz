//! Sidecar search order for packaged and development builds.

use std::path::{Path, PathBuf};

#[test]
fn a_release_build_prefers_its_bundled_sidecars_over_the_build_tree() {
    let workspace = Path::new("/build/buzz");
    let bundle = Path::new("/Applications/Snap Fusion Buzz.app/Contents/MacOS");
    let dirs =
        super::ordered_command_search_dirs(true, workspace, Some(Path::new("/")), Some(bundle));
    assert_eq!(dirs.first().map(PathBuf::as_path), Some(bundle));
    // The build tree is still a fallback, after the bundle.
    assert!(dirs.contains(&workspace.join("target/release")));
}

#[test]
fn a_development_build_prefers_freshly_built_workspace_sidecars() {
    let workspace = Path::new("/src/buzz");
    let exe = Path::new("/src/buzz/target/debug");
    let dirs = super::ordered_command_search_dirs(false, workspace, None, Some(exe));
    assert_eq!(
        dirs[0],
        workspace.join(if cfg!(debug_assertions) {
            "target/debug"
        } else {
            "target/release"
        })
    );
    assert_eq!(dirs.iter().filter(|dir| dir.as_path() == exe).count(), 1);
}
