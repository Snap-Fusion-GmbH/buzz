import { relayClient } from "./relayClient";
import {
  getManagedWorkspaceStatus,
  type ManagedWorkspaceStatus,
} from "./tauriManagedWorkspace";

/** Reconnect only after this managed identity's workspace verifies its access. */
export async function recoverManagedRelayMembership(
  relayUrl: string | null,
  publicKey: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!relayUrl || !publicKey) return false;
  signal?.throwIfAborted();
  let status: ManagedWorkspaceStatus;
  try {
    status = await getManagedWorkspaceStatus();
  } catch {
    signal?.throwIfAborted();
    return false;
  }
  signal?.throwIfAborted();
  if (
    !status.enabled ||
    !status.signed_in ||
    status.public_key !== publicKey ||
    status.profile?.relay_url.replace(/\/$/, "") !== relayUrl.replace(/\/$/, "")
  ) {
    return false;
  }
  await relayClient.preconnect();
  signal?.throwIfAborted();
  return true;
}
