import { invoke } from "@tauri-apps/api/core";

export type ManagedWorkspaceStatus = {
  enabled: boolean;
  signed_in: boolean;
  workspace_id: string | null;
  public_key: string | null;
  profile: {
    workspace_name: string;
    display_name: string | null;
    role: "member" | "admin";
    relay_url: string;
    channels: Array<{ id: string; name: string | null }>;
    credentials_included: false;
    teams_message_sync: boolean;
  } | null;
};

export function getManagedWorkspaceStatus() {
  return invoke<ManagedWorkspaceStatus>("managed_workspace_status");
}

/** True when this build carries a managed workspace profile (no I/O). */
export function isManagedWorkspaceBuild() {
  return invoke<boolean>("managed_workspace_configured");
}

export function signInManagedWorkspace() {
  return invoke<ManagedWorkspaceStatus>("managed_workspace_login");
}

export function cancelManagedWorkspaceSignIn() {
  return invoke<void>("cancel_managed_workspace_login");
}
