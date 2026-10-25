import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { CommunitiesProvider } from "@/features/communities/useCommunities";
import { relayClient } from "@/shared/api/relayClient";
import { resetActiveAgentTurnsStore } from "./activeAgentTurnsStore.ts";
import {
  getAgentObserverSnapshot,
  resetAgentObserverStore,
} from "./observerRelayStore.ts";
import { useAgentObserverIngestion } from "./useAgentObserverIngestion.ts";

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const LOCAL = "c".repeat(64);
const REMOTE = "d".repeat(64);
const FOREIGN = "e".repeat(64);
const CHANNEL = "remote-agent-dm";
const originalSubscribe = relayClient.subscribeInteractive;
const clients = new Set();

afterEach(() => {
  cleanup();
  resetAgentObserverStore();
  resetActiveAgentTurnsStore();
  relayClient.subscribeInteractive = originalSubscribe;
  for (const client of clients) client.clear();
  clients.clear();
  clearMocks();
  localStorage.clear();
});

function setup(remoteOwner = OWNER) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  clients.add(client);
  const directory = (ownerPubkey) => [
    { pubkey: LOCAL, ownerPubkey: OWNER, status: "online" },
    { pubkey: REMOTE, ownerPubkey, status: "unknown" },
    { pubkey: FOREIGN, ownerPubkey: OTHER, status: "unknown" },
  ];
  client.setQueryData(["identity"], { pubkey: OWNER });
  client.setQueryData(
    ["managed-agents"],
    [{ pubkey: LOCAL, status: "running" }],
  );
  client.setQueryData(["relay-agents"], directory(remoteOwner));
  const profilesKey = ["users-batch", LOCAL, REMOTE, FOREIGN];
  client.setQueryData(profilesKey, {
    profiles: {
      [LOCAL]: { displayName: "Local", ownerPubkey: OWNER },
      [REMOTE]: { displayName: "Remote", ownerPubkey: null },
      [FOREIGN]: { displayName: "Foreign", ownerPubkey: OWNER },
    },
    missing: [],
  });
  const subscriptions = [];
  const decrypted = [];
  relayClient.subscribeInteractive = async (filter, onEvent) => {
    subscriptions.push({ filter, onEvent });
    return async () => {};
  };
  mockIPC((command, args) => {
    if (command === "get_identity")
      return { pubkey: OWNER, display_name: "Owner" };
    if (command === "decrypt_observer_event") {
      const event = JSON.parse(args.eventJson);
      decrypted.push(event);
      return JSON.parse(event.content);
    }
    throw new Error(`Unexpected IPC: ${command}`);
  });
  const wrapper = ({ children }) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(CommunitiesProvider, null, children),
    );
  return {
    client,
    decrypted,
    directory,
    profilesKey,
    subscriptions,
    wrapper,
  };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function frame(pubkey = REMOTE, seq = 1) {
  return {
    id: String(seq).repeat(64),
    pubkey,
    created_at: 1_792_925_650 + seq,
    kind: 24200,
    tags: [
      ["p", OWNER],
      ["agent", pubkey],
      ["frame", "telemetry"],
    ],
    content: JSON.stringify({
      seq,
      timestamp: new Date(1_792_925_650_000 + seq * 1000).toISOString(),
      kind: "turn_started",
      agentIndex: 0,
      channelId: CHANNEL,
      sessionId: "remote-session",
      turnId: `turn-${seq}`,
      payload: {},
    }),
    sig: "f".repeat(128),
  };
}

async function deliver(subscription, event) {
  await act(async () => {
    subscription.onEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("directory ownership updates admit remote frames despite stale presentation profiles", async () => {
  const fixture = setup(null);
  renderHook(() => useAgentObserverIngestion(), {
    wrapper: fixture.wrapper,
  });
  await settle();
  assert.equal(fixture.subscriptions.length, 1);
  const subscription = fixture.subscriptions[0];
  assert.deepEqual(subscription.filter["#p"], [OWNER]);

  await deliver(subscription, frame());
  assert.equal(fixture.decrypted.length, 0);

  await act(async () => {
    fixture.client.setQueryData(["relay-agents"], fixture.directory(OWNER));
  });
  await settle();
  await deliver(subscription, frame());
  assert.equal(getAgentObserverSnapshot(REMOTE).events.length, 1);
  assert.equal(fixture.decrypted.length, 1);
  assert.equal(
    fixture.client.getQueryData(fixture.profilesKey).profiles[REMOTE]
      .ownerPubkey,
    null,
  );
  assert.equal(fixture.subscriptions.length, 1);
});

test("relay ownership gates decryption and an ownership change revokes trust", async () => {
  const fixture = setup();
  renderHook(() => useAgentObserverIngestion(), {
    wrapper: fixture.wrapper,
  });
  await settle();
  const subscription = fixture.subscriptions[0];
  await deliver(subscription, frame(FOREIGN));
  await deliver(subscription, { ...frame(), pubkey: FOREIGN });
  assert.equal(fixture.decrypted.length, 0);

  await deliver(subscription, frame());
  assert.equal(fixture.decrypted.length, 1);

  await act(async () => {
    fixture.client.setQueryData(["relay-agents"], fixture.directory(OTHER));
  });
  await settle();
  await deliver(subscription, frame(REMOTE, 2));
  assert.equal(fixture.decrypted.length, 1);
  assert.equal(getAgentObserverSnapshot(REMOTE).events.length, 1);
});
