import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("../../scripts/bundle-sidecars.sh", import.meta.url),
);
const triple = "aarch64-apple-darwin";
const binaries = [
  "buzz-acp",
  "buzz-agent",
  "buzz-dev-mcp",
  "git-credential-nostr",
  "buzz",
  "buzz-backend-kubernetes",
];

test("bundling respects isolated Cargo targets and preserves default target layouts", {
  skip: process.platform === "win32",
}, () => {
  for (const scenario of [
    { isolated: false, explicitTarget: true },
    { isolated: true, explicitTarget: true },
    { isolated: true, explicitTarget: false },
  ]) {
    const folder = mkdtempSync(join(tmpdir(), "buzz-sidecar-target-"));
    try {
      const project = join(folder, "project");
      const tools = join(folder, "tools");
      mkdirSync(project);
      mkdirSync(tools);
      const rustc = join(tools, "rustc");
      writeFileSync(rustc, `#!/bin/sh\nprintf 'host: ${triple}\\n'\n`);
      chmodSync(rustc, 0o755);
      const target = scenario.isolated
        ? join(folder, "isolated cargo artifacts")
        : join(project, "target");
      const source = scenario.explicitTarget
        ? join(target, triple, "release")
        : join(target, "release");
      mkdirSync(source, { recursive: true });
      for (const binary of binaries) {
        writeFileSync(join(source, binary), binary);
      }
      const environment = {
        ...process.env,
        PATH: `${tools}${delimiter}${process.env.PATH}`,
      };
      delete environment.CARGO_TARGET_DIR;
      if (scenario.isolated) environment.CARGO_TARGET_DIR = target;
      const result = spawnSync(
        "bash",
        [script, ...(scenario.explicitTarget ? [triple] : [])],
        { cwd: project, env: environment, encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      for (const binary of binaries) {
        assert.equal(
          readFileSync(
            join(project, "desktop/src-tauri/binaries", `${binary}-${triple}`),
            "utf8",
          ),
          binary,
        );
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
});
