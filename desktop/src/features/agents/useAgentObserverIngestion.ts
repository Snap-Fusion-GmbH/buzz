import * as React from "react";

import { useActiveAgentTurnsBridge } from "@/features/agents/activeAgentTurnsStore";
import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { useManagedAgentObserverBridge } from "@/features/agents/observerRelayStore";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { ManagedAgent, RelayAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

type IngestionAgent = Pick<ManagedAgent, "pubkey" | "status">;

/**
 * Combine locally managed agents with relay agents the current identity
 * declared-owns (NIP-OA `ownerPubkey == me`) into one ingestion list.
 *
 * Ownership comes from the verified relay directory, not a separate cached
 * presentation-profile query. Managed agents keep their real status; owned relay
 * agents that are not managed locally are treated as `deployed` so the observer
 * subscription starts and their frames decrypt. Registering non-owned agents would be
 * pointless — observer frames are `#p`-addressed to the owner, so frames for
 * agents we do not own never arrive on our subscription in the first place.
 */
export function combineObserverIngestionAgents(
  managedAgents: readonly IngestionAgent[],
  relayAgents: readonly Pick<RelayAgent, "pubkey" | "ownerPubkey">[],
  currentPubkey: string | null | undefined,
): IngestionAgent[] {
  const managed = managedAgents.map((agent) => ({
    pubkey: agent.pubkey,
    status: agent.status,
  }));
  if (!currentPubkey) {
    return managed;
  }

  const managedSet = new Set(
    managed.map((agent) => normalizePubkey(agent.pubkey)),
  );
  const me = normalizePubkey(currentPubkey);
  const owned: IngestionAgent[] = [];
  for (const { pubkey, ownerPubkey } of relayAgents) {
    const key = normalizePubkey(pubkey);
    if (managedSet.has(key)) {
      continue;
    }
    if (ownerPubkey && normalizePubkey(ownerPubkey) === me) {
      owned.push({ pubkey, status: "deployed" as const });
    }
  }
  return [...managed, ...owned];
}

/**
 * App-level owner-global observer ingestion.
 *
 * Mounted once in AppShell so observer frames (kind 24200) are received,
 * decrypted, and folded into the derived active-turns store regardless of
 * which screen or panel happens to be open. Individual surfaces read from the
 * stores; none of them need to mount their own bridge for ingestion to work.
 *
 * This is the product invariant: if the current identity owns an agent (local
 * managed agent or declared-owned relay agent), its turn activity is ingested
 * app-wide — not only while a panel that happens to mount a bridge is open.
 *
 * Mounts before identity resolves by design: while `currentPubkey` is still
 * `undefined`, `combineObserverIngestionAgents` returns managed agents only,
 * and relay-owned agents are folded in on the render after identity arrives.
 * Do not gate this hook on identity/startup readiness — that would drop
 * managed-agent observer coverage during startup.
 */
export function useAgentObserverIngestion() {
  const identityQuery = useIdentityQuery();
  const currentPubkey = identityQuery.data?.pubkey;

  const managedAgentsQuery = useManagedAgentsQuery();
  const managedAgents = managedAgentsQuery.data;

  const relayAgentsQuery = useRelayAgentsQuery();
  const relayAgents = relayAgentsQuery.data;
  const ingestionAgents = React.useMemo(
    () =>
      combineObserverIngestionAgents(
        managedAgents ?? [],
        relayAgents ?? [],
        currentPubkey,
      ),
    [currentPubkey, managedAgents, relayAgents],
  );

  useManagedAgentObserverBridge(ingestionAgents);
  useActiveAgentTurnsBridge(ingestionAgents);
}
