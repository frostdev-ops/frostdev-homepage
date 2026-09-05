fn main() {
    // The page inside the window calls these two; naming them here is what
    // generates the allow-ward-* permissions capabilities/remote.json grants.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["ward_browser", "ward_touch"])),
    )
    .expect("tauri-build");
}
