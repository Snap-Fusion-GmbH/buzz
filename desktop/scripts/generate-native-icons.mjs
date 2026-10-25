import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const iconsRoot = path.join(desktopRoot, "src-tauri", "icons");
const tauriPackagePath = fileURLToPath(
  import.meta.resolve("@tauri-apps/cli/package.json"),
);
const tauriEntrypoint = path.join(path.dirname(tauriPackagePath), "tauri.js");
const staging = mkdtempSync(path.join(tmpdir(), "buzz-native-icons-"));
const sizes = [16, 56, 64, 112, 168, 256, 512, 1024];
try {
  for (const [source, extraArgs] of [
    ["paired-core.svg", ["--ios-color", "#0B0B0B"]],
    ["paired-core.svg", sizes.flatMap((size) => ["--png", String(size)])],
    ["paired-core-micro.svg", ["--png", "16", "--png", "32"]],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        tauriEntrypoint,
        "icon",
        path.join(iconsRoot, source),
        "--output",
        staging,
        ...extraArgs,
      ],
      {
        cwd: desktopRoot,
        stdio: "inherit",
        timeout: 60_000,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Native icon generation failed: ${result.status}`);
    }
  }
  cpSync(staging, iconsRoot, { recursive: true });
} finally {
  rmSync(staging, { recursive: true, force: true });
}
