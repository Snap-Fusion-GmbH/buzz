import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";

/** Agent CLIs the first-run setup looks for, in display order. */
export const AGENT_TOOL_SETUP_RUNTIME_IDS = ["claude", "codex"] as const;

export type AgentToolStatus =
  | { kind: "ready" }
  /** The CLI is present and only its ACP adapter is missing or outdated. */
  | { kind: "adapter_needed"; automatic: boolean }
  /** The vendor CLI is missing: installing it needs the user's consent. */
  | { kind: "cli_missing" }
  | { kind: "signed_out" }
  | { kind: "check_again"; detail: string | null };

export function agentToolStatus(
  runtime: AcpRuntimeCatalogEntry,
): AgentToolStatus {
  switch (runtime.availability) {
    case "adapter_missing":
    case "adapter_outdated":
      return {
        kind: "adapter_needed",
        // Only an installed CLI makes this an adapter-only install. Buzz's
        // private Node runtime covers npm, unless this platform lacks it.
        automatic:
          runtime.canAutoInstall &&
          !runtime.nodeRequired &&
          Boolean(runtime.underlyingCliPath),
      };
    case "cli_missing":
    case "not_installed":
      return { kind: "cli_missing" };
    case "available":
      break;
  }
  switch (runtime.authStatus.status) {
    case "logged_in":
    case "not_applicable":
      return { kind: "ready" };
    case "logged_out":
      return { kind: "signed_out" };
    case "config_invalid":
      return { kind: "check_again", detail: runtime.authStatus.diagnostic };
    case "unknown":
      return { kind: "check_again", detail: null };
  }
}

/** The setup's runtimes present in the catalog, in display order. */
export function agentToolSetupRuntimes(
  runtimes: readonly AcpRuntimeCatalogEntry[],
): AcpRuntimeCatalogEntry[] {
  return AGENT_TOOL_SETUP_RUNTIME_IDS.flatMap((id) => {
    const runtime = runtimes.find((entry) => entry.id === id);
    return runtime ? [runtime] : [];
  });
}

/**
 * Runtimes whose adapter Buzz installs without asking. A missing vendor CLI
 * is never on this list: installing one runs the vendor's script.
 */
export function automaticAdapterInstalls(
  runtimes: readonly AcpRuntimeCatalogEntry[],
): string[] {
  return agentToolSetupRuntimes(runtimes)
    .filter((runtime) => {
      const status = agentToolStatus(runtime);
      return status.kind === "adapter_needed" && status.automatic;
    })
    .map((runtime) => runtime.id);
}

// Agent CLIs and adapters belong to this computer, not to an identity, so the
// first-run setup is offered once per machine.
export const AGENT_TOOL_SETUP_STORAGE_KEY = "buzz.agentToolSetup.completedAt";

export function agentToolSetupCompleted(): boolean {
  try {
    return window.localStorage.getItem(AGENT_TOOL_SETUP_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function markAgentToolSetupCompleted(): void {
  try {
    window.localStorage.setItem(
      AGENT_TOOL_SETUP_STORAGE_KEY,
      String(Date.now()),
    );
  } catch {
    // Storage unavailable: the setup is offered again next launch.
  }
}
