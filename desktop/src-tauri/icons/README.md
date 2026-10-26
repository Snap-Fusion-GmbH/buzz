# Paired Core native icons

`paired-core.svg` is the native-icon vector master for the selected **07 / Paired
Core** direction. It uses opposing rounded corners and two separate cores in
wafer lime (`#CEDC2E`) and white on near-black (`#0B0B0B`). The centre gap keeps
the cores distinct at small sizes. No font, embedded raster, or external asset
is required.

`paired-core-micro.svg` pixel-fits the 16/32 px PNGs and increases the core gap
for small displays. The large master is not a substitute for these tiny exports.

The selected reference remains unchanged in
`desktop/src-tauri/icons/paired-core-reference.png` (SHA-256
`f4eeae1185d75bd80660a7e2e3269a1b149ea0cbf71d1669f219c161b3a5b6cc`).
The reference was concept artwork, not an installed icon catalog. These exports
apply that selected direction to native application icons; the in-app wordmark
and illustrations are a separate surface.

Regenerate the native catalog from the repository root:

```sh
. ./bin/activate-hermit
pnpm --dir desktop icons:generate
```

The pinned Tauri CLI generates the platform catalogs plus 16, 56, 64, 112, 168,
256, 512, and 1024 px PNG exports. iOS backgrounds use the same near-black rather
than white. Generation stages all outputs before replacing the catalog.
`buzz-source.png` is retained as a legacy bee reference, not the current master.

Verify 16, 32, 56, 112, and 168 px exports at their native size before changing
the geometry. Managed Linux builds must also match the GTK application ID to
their visible desktop-entry filename; replacing image files cannot repair an
unmatched dock window.
