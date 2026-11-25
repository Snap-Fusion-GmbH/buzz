import { expect, type Page, test } from "@playwright/test";

import type { ManagedWorkspaceStatus } from "../../src/shared/api/tauriManagedWorkspace";
import { installMockBridge } from "../helpers/bridge";

const signedIn: ManagedWorkspaceStatus = {
  enabled: true,
  signed_in: true,
  workspace_id: "fixture-rd",
  public_key: "deadbeef".repeat(8),
  profile: {
    workspace_name: "Snap Fusion",
    display_name: "Fixture member",
    role: "member",
    relay_url: "wss://managed.example.invalid",
    channels: [],
    credentials_included: false,
    teams_message_sync: false,
  },
};

const BASE = {
  avatar_url: "",
  default_args: [],
  mcp_command: null,
  can_auto_install: true,
  node_required: false,
};

const CLAUDE_ADAPTER_MISSING = {
  ...BASE,
  id: "claude",
  label: "Claude Code",
  availability: "adapter_missing",
  command: null,
  binary_path: null,
  install_hint: "Buzz talks to the Claude Code CLI through an ACP adapter.",
  install_instructions_url:
    "https://github.com/agentclientprotocol/claude-agent-acp",
  cli_install_command: "curl -fsSL https://claude.ai/install.sh | bash",
  underlying_cli_path: "/usr/local/bin/claude",
  auth_status: { status: "logged_in" },
};

const CLAUDE_READY = {
  ...CLAUDE_ADAPTER_MISSING,
  availability: "available",
  command: "claude-agent-acp",
  binary_path: "/home/user/.local/share/Buzz/node-tools/bin/claude-agent-acp",
};

const CODEX_NOT_INSTALLED = {
  ...BASE,
  id: "codex",
  label: "Codex",
  availability: "not_installed",
  command: null,
  binary_path: null,
  install_hint: "Buzz talks to Codex through the Codex CLI.",
  install_instructions_url: "https://developers.openai.com/codex/cli/",
  cli_install_command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  underlying_cli_path: null,
  auth_status: { status: "unknown" },
};

const BUZZ_AGENT = {
  ...BASE,
  id: "buzz-agent",
  label: "Buzz Agent",
  availability: "available",
  command: "buzz-agent",
  binary_path: "/usr/local/bin/buzz-agent",
  install_hint: "",
  install_instructions_url: "https://github.com/block/buzz",
  can_auto_install: false,
  underlying_cli_path: null,
  auth_status: { status: "not_applicable" },
};

function installCalls(page: Page) {
  return page.evaluate(() =>
    (
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{
            command: string;
            payload: unknown;
          }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? []
    )
      .filter((entry) => entry.command === "install_acp_runtime")
      .map((entry) => entry.payload),
  );
}

test("first sign-in installs a missing adapter and asks before installing a CLI", async ({
  page,
}) => {
  await installMockBridge(
    page,
    {
      managedWorkspace: { status: signedIn },
      acpRuntimesCatalog: [
        CLAUDE_ADAPTER_MISSING,
        CODEX_NOT_INSTALLED,
        BUZZ_AGENT,
      ],
      acpRuntimesCatalogAfterInstall: [
        CLAUDE_READY,
        CODEX_NOT_INSTALLED,
        BUZZ_AGENT,
      ],
      installAcpRuntimeOutputLines: ["added 12 packages in 3s"],
      installAcpRuntimeDelayMs: 1_500,
    },
    {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
      relayWsUrl: "wss://managed.example.invalid",
      seedAgentToolSetupDone: false,
    },
  );
  await page.goto("/");

  const setup = page.getByTestId("agent-tool-setup");
  await expect(setup).toBeVisible();
  // While the adapter installs, the installer's latest output is the progress.
  await expect(page.getByTestId("agent-tool-claude-install-output")).toHaveText(
    "added 12 packages in 3s",
  );
  // The adapter installs on its own because the Claude Code CLI is present.
  await expect(page.getByTestId("agent-tool-claude-status")).toHaveText(
    "Ready",
  );
  // Codex's CLI is missing: Buzz shows the vendor installer and waits.
  const codex = page.getByTestId("agent-tool-codex");
  await expect(codex).toContainText("Not installed on this computer");
  // Codex shows OpenAI's Blossom, not the generic terminal fallback.
  await expect(codex.locator("img")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml/,
  );
  await expect(codex).toContainText(
    "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  );
  expect(await installCalls(page)).toEqual([
    { runtimeId: "claude", adapterOnly: true },
  ]);

  // Only an explicit click runs the vendor installer (a full install).
  await codex.getByRole("button", { name: "Install Codex" }).click();
  await expect
    .poll(() => installCalls(page))
    .toEqual([
      { runtimeId: "claude", adapterOnly: true },
      { runtimeId: "codex" },
    ]);

  await page.getByRole("button", { name: "Continue" }).click();
  // Claude Code is ready but has no agent yet: Buzz stays closed until one exists.
  const agentStep = page.getByTestId("required-agent-claude");
  await expect(agentStep).toBeVisible();
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
  await agentStep
    .getByRole("button", { name: "Create Claude Code agent" })
    .click();
  await expect(page.getByTestId("app-sidebar")).toBeVisible();

  // Offered once per computer: a relaunch goes straight to the app.
  await page.reload();
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await expect(setup).toHaveCount(0);
  await expect(agentStep).toHaveCount(0);
});

test("skipping leaves every install to the user", async ({ page }) => {
  await installMockBridge(
    page,
    {
      managedWorkspace: { status: signedIn },
      acpRuntimesCatalog: [CODEX_NOT_INSTALLED, BUZZ_AGENT],
    },
    {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
      relayWsUrl: "wss://managed.example.invalid",
      seedAgentToolSetupDone: false,
    },
  );
  await page.goto("/");

  await expect(page.getByTestId("agent-tool-codex")).toContainText(
    "Not installed on this computer",
  );
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  expect(await installCalls(page)).toEqual([]);
});

test("a signed-out CLI without adapter sign-in methods opens the CLI's own login", async ({
  page,
}) => {
  const signedOut = { ...CLAUDE_READY, auth_status: { status: "logged_out" } };
  await installMockBridge(
    page,
    {
      managedWorkspace: { status: signedIn },
      // The real Claude adapter advertises no ACP auth method while signed
      // out; the mock's default `acpAuthMethods` is empty too.
      acpRuntimesCatalog: [signedOut, BUZZ_AGENT],
      acpRuntimesCatalogAfterConnect: [CLAUDE_READY, BUZZ_AGENT],
    },
    {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
      relayWsUrl: "wss://managed.example.invalid",
      seedAgentToolSetupDone: false,
    },
  );
  await page.goto("/");

  const claude = page.getByTestId("agent-tool-claude");
  await expect(page.getByTestId("agent-tool-claude-status")).toHaveText(
    "Signed out",
  );
  await claude.getByRole("button", { name: "Sign in to Claude Code" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          (
            window as Window & {
              __BUZZ_E2E_COMMAND_LOG__?: Array<{
                command: string;
                payload: unknown;
              }>;
            }
          ).__BUZZ_E2E_COMMAND_LOG__ ?? []
        )
          .filter((entry) => entry.command === "launch_cli_login")
          .map((entry) => entry.payload),
      ),
    )
    .toEqual([{ runtimeId: "claude" }]);
  // Polling picks up the completed sign-in.
  await expect(page.getByTestId("agent-tool-claude-status")).toHaveText(
    "Ready",
    { timeout: 15_000 },
  );
  await expect(page.getByRole("button", { name: "Open Buzz" })).toBeEnabled();
});

const CODEX_READY = {
  ...CODEX_NOT_INSTALLED,
  availability: "available",
  command: "codex-acp",
  binary_path: "/home/user/.local/share/Buzz/node-tools/bin/codex-acp",
  underlying_cli_path: "/usr/local/bin/codex",
  auth_status: { status: "logged_in" },
};

function createdPersonas(page: Page) {
  return page.evaluate(() =>
    (
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{
            command: string;
            payload: { input?: Record<string, unknown> } | null;
          }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? []
    )
      .filter((entry) => entry.command === "create_persona")
      .map((entry) => ({
        displayName: entry.payload?.input?.displayName,
        runtime: entry.payload?.input?.runtime,
        model: entry.payload?.input?.model ?? null,
      })),
  );
}

test("every ready harness needs an agent before Buzz opens, on any launch", async ({
  page,
}) => {
  await installMockBridge(
    page,
    {
      managedWorkspace: { status: signedIn },
      // Tool setup finished long ago (the helper seeds it); both harnesses are
      // ready but neither has an agent.
      acpRuntimesCatalog: [CLAUDE_READY, CODEX_READY, BUZZ_AGENT],
      discoverAgentModels: {
        models: [
          { id: "default", name: "Default (recommended)" },
          { id: "opus", name: "Opus 5.5" },
          { id: "sonnet", name: "Sonnet 5.5" },
        ],
        agentDefaultModel: "default",
        supportsSwitching: true,
      },
    },
    {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
      relayWsUrl: "wss://managed.example.invalid",
    },
  );
  await page.goto("/");

  const claudeStep = page.getByTestId("required-agent-claude");
  await expect(claudeStep).toContainText("Agent 1 of 2");
  await expect(claudeStep).toContainText("Set up your Claude Code agent");
  await expect(claudeStep.getByLabel("Agent name")).toHaveValue("Claude");
  await claudeStep.getByLabel("Model").selectOption({ label: "Sonnet 5.5" });
  await claudeStep
    .getByRole("button", { name: "Create Claude Code agent" })
    .click();

  const codexStep = page.getByTestId("required-agent-codex");
  await expect(codexStep).toContainText("Agent 2 of 2");
  await codexStep.getByLabel("Agent name").fill("Builder");
  await codexStep.getByRole("button", { name: "Create Codex agent" }).click();

  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  expect(await createdPersonas(page)).toEqual([
    { displayName: "Claude", runtime: "claude", model: "sonnet" },
    { displayName: "Builder", runtime: "codex", model: null },
  ]);
});

test("a signed-out or missing harness never blocks Buzz", async ({ page }) => {
  await installMockBridge(
    page,
    {
      managedWorkspace: { status: signedIn },
      acpRuntimesCatalog: [
        { ...CLAUDE_READY, auth_status: { status: "logged_out" } },
        CODEX_NOT_INSTALLED,
        BUZZ_AGENT,
      ],
    },
    {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
      relayWsUrl: "wss://managed.example.invalid",
    },
  );
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await expect(page.getByTestId(/^required-agent-/)).toHaveCount(0);
});
