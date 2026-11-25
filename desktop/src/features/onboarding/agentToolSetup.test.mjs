import assert from "node:assert/strict";
import test from "node:test";

import {
  agentToolSetupRuntimes,
  agentToolStatus,
  automaticAdapterInstalls,
} from "./agentToolSetup.ts";

function runtime(overrides) {
  return {
    id: "claude",
    label: "Claude Code",
    availability: "available",
    canAutoInstall: true,
    nodeRequired: false,
    underlyingCliPath: "/usr/local/bin/claude",
    authStatus: { status: "logged_in" },
    ...overrides,
  };
}

test("classifies every availability and sign-in state", () => {
  for (const [overrides, expected] of [
    [{}, { kind: "ready" }],
    [{ authStatus: { status: "not_applicable" } }, { kind: "ready" }],
    [{ authStatus: { status: "logged_out" } }, { kind: "signed_out" }],
    [
      { authStatus: { status: "config_invalid", diagnostic: "bad config" } },
      { kind: "check_again", detail: "bad config" },
    ],
    [
      { authStatus: { status: "unknown" } },
      { kind: "check_again", detail: null },
    ],
    [
      { availability: "adapter_missing" },
      { kind: "adapter_needed", automatic: true },
    ],
    [
      { availability: "adapter_outdated" },
      { kind: "adapter_needed", automatic: true },
    ],
    [
      { availability: "adapter_missing", nodeRequired: true },
      { kind: "adapter_needed", automatic: false },
    ],
    [
      { availability: "adapter_missing", canAutoInstall: false },
      { kind: "adapter_needed", automatic: false },
    ],
    [{ availability: "cli_missing" }, { kind: "cli_missing" }],
    [{ availability: "not_installed" }, { kind: "cli_missing" }],
  ]) {
    assert.deepEqual(
      agentToolStatus(runtime(overrides)),
      expected,
      JSON.stringify(overrides),
    );
  }
});

test("never installs automatically without the vendor CLI on this computer", () => {
  const catalog = [
    runtime({ availability: "adapter_missing" }),
    runtime({
      id: "codex",
      availability: "not_installed",
      underlyingCliPath: null,
    }),
    runtime({ id: "goose", availability: "adapter_missing" }),
  ];
  assert.deepEqual(automaticAdapterInstalls(catalog), ["claude"]);

  // A probe that reports a missing adapter without a resolved CLI is not
  // trusted as "CLI present": the vendor installer would run.
  for (const availability of [
    "cli_missing",
    "not_installed",
    "adapter_missing",
  ]) {
    assert.deepEqual(
      automaticAdapterInstalls([
        runtime({ id: "codex", availability, underlyingCliPath: null }),
      ]),
      [],
      availability,
    );
  }
});

test("lists Claude Code then Codex, skipping runtimes the catalog lacks", () => {
  const catalog = [
    runtime({ id: "codex" }),
    runtime({ id: "buzz-agent" }),
    runtime({ id: "claude" }),
  ];
  assert.deepEqual(
    agentToolSetupRuntimes(catalog).map((entry) => entry.id),
    ["claude", "codex"],
  );
  assert.deepEqual(
    agentToolSetupRuntimes([runtime({ id: "codex" })]).map((entry) => entry.id),
    ["codex"],
  );
});
