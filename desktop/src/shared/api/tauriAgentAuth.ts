import type {
  AcpAuthMethod,
  AcpAuthMethodsResult,
  ConnectAcpRuntimeResult,
} from "@/shared/api/types";
import { invokeTauri } from "@/shared/api/tauri";

type RawAcpAuthMethod = {
  id: string;
  name: string;
  description?: string | null;
  type?: string | null;
  args?: string[];
  command?: string[];
  _meta?: unknown;
};

export type RawAcpAuthMethodsResult = {
  methods: RawAcpAuthMethod[];
};

export type RawConnectAcpRuntimeResult = {
  launched: boolean;
};

function fromRawAcpAuthMethod(method: RawAcpAuthMethod): AcpAuthMethod {
  return {
    id: method.id,
    name: method.name,
    description: method.description ?? null,
    type: method.type ?? null,
    args: method.args ?? [],
    command: method.command ?? [],
    meta: method._meta ?? null,
  };
}

export async function discoverAcpAuthMethods(
  runtimeId: string,
): Promise<AcpAuthMethodsResult> {
  const raw = await invokeTauri<RawAcpAuthMethodsResult>(
    "discover_acp_auth_methods",
    { runtimeId },
  );
  return { methods: raw.methods.map(fromRawAcpAuthMethod) };
}

/**
 * Open a terminal running the vendor CLI's own login, for runtimes whose
 * adapter advertises no ACP auth method. Buzz never sees the credentials.
 */
export async function launchCliLogin(
  runtimeId: string,
): Promise<ConnectAcpRuntimeResult> {
  return invokeTauri<RawConnectAcpRuntimeResult>("launch_cli_login", {
    runtimeId,
  });
}

/** Update a setup harness's vendor CLI in a visible terminal. */
export async function updateHarnessCli(
  runtimeId: string,
): Promise<ConnectAcpRuntimeResult> {
  return invokeTauri<RawConnectAcpRuntimeResult>("update_harness_cli", {
    runtimeId,
  });
}

export type ComponentVersion = {
  installed: string | null;
  latest: string | null;
  update_available: boolean;
};

export type HarnessUpdateInfo = {
  runtime_id: string;
  adapter: ComponentVersion;
  cli: ComponentVersion;
  cli_update_command: string | null;
};

/** Installed vs latest adapter and CLI versions of the setup harnesses. */
export async function checkHarnessUpdates(): Promise<HarnessUpdateInfo[]> {
  return invokeTauri<HarnessUpdateInfo[]>("check_harness_updates");
}

export async function connectAcpRuntime(
  runtimeId: string,
  methodId: string,
): Promise<ConnectAcpRuntimeResult> {
  return invokeTauri<RawConnectAcpRuntimeResult>("connect_acp_runtime", {
    request: { runtimeId, methodId },
  });
}
