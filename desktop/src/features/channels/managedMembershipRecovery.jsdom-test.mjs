import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { refreshChannelsQuery } from "./hooks.ts";
import { relayClient } from "@/shared/api/relayClient";

const RELAY = "wss://relay.example.invalid";
const PUBLIC_KEY = "a".repeat(64);
const DENIED = new Error(
  "relay returned 403 Forbidden: You must be a relay member to access this relay",
);
const READY = {
  enabled: true,
  signed_in: true,
  public_key: PUBLIC_KEY,
  profile: { relay_url: RELAY },
};
const CHANNEL = {
  id: "general",
  name: "General",
  channelType: "stream",
  lastMessageAt: null,
};

afterEach(() => clearMocks());

function refresh(fetchChannels, signal) {
  return refreshChannelsQuery({
    queryClient: new QueryClient(),
    initialSnapshotPair: null,
    relayUrl: RELAY,
    ownerPubkey: PUBLIC_KEY,
    fetchChannels,
    persistSnapshot() {},
    signal,
  });
}

test("a membership-denied channel read verifies the same managed identity and reconnects once", async (context) => {
  const commands = [];
  mockIPC((command) => {
    commands.push(command);
    return READY;
  });
  const reconnect = context.mock.method(
    relayClient,
    "preconnect",
    async () => {},
  );
  let reads = 0;
  const channels = await refresh(async () => {
    if (++reads === 1) throw DENIED;
    return { channels: [CHANNEL], hash: "fresh", lastMessages: {} };
  });
  assert.deepEqual(channels, [CHANNEL]);
  assert.deepEqual(commands, ["managed_workspace_status"]);
  assert.equal(reconnect.mock.callCount(), 1);
  assert.equal(reads, 2);

  reads = 0;
  await assert.rejects(
    refresh(async () => {
      reads += 1;
      throw DENIED;
    }),
    /relay member/,
  );
  assert.equal(reads, 2, "a persistent denial must not retry indefinitely");
});

test("unmanaged, denied, unavailable, or mismatched identities cannot reconnect", async (context) => {
  let status;
  mockIPC(() => {
    if (typeof status === "string") throw status;
    return status;
  });
  const reconnect = context.mock.method(
    relayClient,
    "preconnect",
    async () => {},
  );
  for (status of [
    { enabled: false },
    { ...READY, signed_in: false },
    { ...READY, public_key: "b".repeat(64) },
    { ...READY, profile: { relay_url: "wss://other.example.invalid" } },
    "managed_workspace_access_denied",
    "managed_workspace_unavailable",
  ]) {
    let reads = 0;
    await assert.rejects(
      refresh(async () => {
        reads += 1;
        throw DENIED;
      }),
      /relay member/,
    );
    assert.equal(reads, 1);
  }
  assert.equal(reconnect.mock.callCount(), 0);
});

test("channel denials and other HTTP failures do not trigger membership recovery", async (context) => {
  const commands = [];
  mockIPC((command) => {
    commands.push(command);
    return READY;
  });
  const reconnect = context.mock.method(
    relayClient,
    "preconnect",
    async () => {},
  );
  for (const message of [
    "relay returned 403 Forbidden: channel access denied",
    "relay returned 503 Service Unavailable",
    "relay returned 403 Forbidden: blocked: banned",
  ]) {
    await assert.rejects(
      refresh(async () => {
        throw new Error(message);
      }),
    );
  }
  assert.deepEqual(commands, []);
  assert.equal(reconnect.mock.callCount(), 0);
});

test("a canceled community cannot reconnect after workspace verification completes", async (context) => {
  const controller = new AbortController();
  mockIPC(() => {
    controller.abort();
    return READY;
  });
  const reconnect = context.mock.method(
    relayClient,
    "preconnect",
    async () => {},
  );
  await assert.rejects(
    refresh(async () => {
      throw DENIED;
    }, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(reconnect.mock.callCount(), 0);
});
