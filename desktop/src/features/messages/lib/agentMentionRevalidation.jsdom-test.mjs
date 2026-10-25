import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, renderHook } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  AgentMentionAuthorizationError,
  useAgentMentionRevalidation,
} from "./agentMentionRevalidation.ts";

const VIEWER = "a".repeat(64);
const AGENT = "b".repeat(64);

afterEach(() => {
  cleanup();
  clearMocks();
});

test("shared-agent Invite preparation queries visible memberships; publication stays destination-scoped", async () => {
  let joined = false;
  const requests = [];
  mockIPC((command, payload) => {
    assert.equal(command, "revalidate_relay_agents");
    requests.push(payload);
    return payload.channelId === "target" && !joined
      ? []
      : [
          {
            pubkey: AGENT,
            name: "OpenRouter Free Model",
            channels: [],
            channel_ids: joined ? ["source", "target"] : ["source"],
            status: "unknown",
            respond_to: "anyone",
            respond_to_allowlist: [],
          },
        ];
  });
  const { result } = renderHook(() =>
    useAgentMentionRevalidation({
      agentPubkeys: new Set([AGENT]),
      getSelectedAgentPubkeys: () => new Set([AGENT]),
      currentPubkey: VIEWER,
      eligibilityScope: { type: "channel", channelId: "target" },
      sharedChannelIds: new Set(["source", "target"]),
      refetchManagedAgents: async () => ({ data: [], error: null }),
    }),
  );

  assert.deepEqual(
    await result.current([AGENT], "target", { phase: "prepare" }),
    [AGENT],
  );
  assert.equal(requests[0].channelId, undefined);
  await assert.rejects(
    result.current([AGENT], "target", { phase: "publish" }),
    AgentMentionAuthorizationError,
  );
  assert.equal(requests[1].channelId, "target");
  joined = true;
  assert.deepEqual(
    await result.current([AGENT], "target", { phase: "publish" }),
    [AGENT],
  );
  assert.equal(requests[2].channelId, "target");
});
