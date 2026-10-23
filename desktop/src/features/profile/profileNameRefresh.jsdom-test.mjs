import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { CommunitiesProvider } from "@/features/communities/useCommunities";
import {
  saveActiveCommunityId,
  saveCommunities,
} from "@/features/communities/communityStorage";
import { useUsersBatchQuery, usersBatchEntryKey } from "./hooks.ts";
import { readCachedUserLabels } from "./lib/userLabelStorage.ts";
import { resolveUserLabel } from "./lib/identity.ts";

const KNOWN = "a".repeat(64);
const NEW_MEMBER = "b".repeat(64);
const RELAY = "wss://profile-refresh.example.invalid";
const NOW = 1_800_000_000_000;
const clients = new Set();

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  clearMocks();
  localStorage.clear();
  focusManager.setFocused(undefined);
});

function seedCommunity(relayUrl = RELAY) {
  saveCommunities([
    {
      id: "fixture",
      name: "Fixture",
      relayUrl,
      pubkey: KNOWN,
      addedAt: "2026-10-22T00:00:00.000Z",
    },
  ]);
  saveActiveCommunityId("fixture");
}

function mount(pubkeys) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.add(client);
  const hook = renderHook(
    () => {
      const query = useUsersBatchQuery(pubkeys);
      return {
        data: query.data,
        isError: query.isError,
        isSuccess: query.isSuccess,
      };
    },
    {
      wrapper: ({ children }) =>
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(CommunitiesProvider, null, children),
        ),
    },
  );
  return { ...hook, client };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function profile(displayName) {
  return {
    display_name: displayName,
    avatar_url: null,
    nip05_handle: null,
    owner_pubkey: null,
  };
}

test("an open conversation resolves a previously missing name without fetching known profiles again", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  focusManager.setFocused(true);
  seedCommunity();
  let published = false;
  const requests = [];
  mockIPC((command, args) => {
    assert.equal(command, "get_users_batch");
    requests.push(args.pubkeys);
    const profiles = {};
    if (args.pubkeys.includes(KNOWN)) profiles[KNOWN] = profile("Alice");
    if (published && args.pubkeys.includes(NEW_MEMBER))
      profiles[NEW_MEMBER] = profile("New Teammate");
    return {
      profiles,
      missing: args.pubkeys.filter((pubkey) => !profiles[pubkey]),
    };
  });
  const hook = mount([KNOWN, NEW_MEMBER]);
  await settle();
  assert.deepEqual(hook.result.current.data.missing, [NEW_MEMBER]);
  hook.client.setQueryData(["user-profile", NEW_MEMBER], {
    pubkey: NEW_MEMBER,
    displayName: NEW_MEMBER,
    hasProfileEvent: false,
    about: null,
  });
  hook.client.setQueryData(["user-profile", KNOWN], {
    pubkey: KNOWN,
    displayName: "Alice",
    hasProfileEvent: true,
    about: "Preserve the detailed profile",
  });
  published = true;
  await act(async () => context.mock.timers.tick(15_000));
  await settle();
  assert.equal(
    resolveUserLabel({
      pubkey: NEW_MEMBER,
      profiles: hook.result.current.data.profiles,
    }),
    "New Teammate",
  );
  assert.deepEqual(requests, [[KNOWN, NEW_MEMBER], [NEW_MEMBER]]);
  assert.equal(
    readCachedUserLabels(RELAY, [NEW_MEMBER]).profiles[NEW_MEMBER].displayName,
    "New Teammate",
  );
  assert.equal(
    hook.client.getQueryData(["user-profile", NEW_MEMBER]).displayName,
    "New Teammate",
  );
  assert.equal(
    hook.client.getQueryData(["user-profile", KNOWN]).about,
    "Preserve the detailed profile",
  );
  await act(async () => context.mock.timers.tick(20 * 60_000));
  await settle();
  assert.equal(
    requests.length,
    2,
    "resolved profiles must stop background retries",
  );
});

test("permanently missing profiles stop automatic retries, but refocusing can resolve a later profile", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  focusManager.setFocused(true);
  seedCommunity();
  let published = false;
  let requests = 0;
  mockIPC(() => {
    requests += 1;
    return published
      ? { profiles: { [NEW_MEMBER]: profile("New Teammate") }, missing: [] }
      : { profiles: {}, missing: [NEW_MEMBER] };
  });
  const hook = mount([NEW_MEMBER]);
  await settle();
  for (const delay of [15_000, 30_000, 60_000, 120_000]) {
    await act(async () => context.mock.timers.tick(delay));
    await settle();
  }
  assert.equal(requests, 5);
  await act(async () => context.mock.timers.tick(24 * 60 * 60_000));
  await settle();
  assert.equal(requests, 5, "unknown identities must not poll indefinitely");
  published = true;
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle();
  assert.equal(
    hook.result.current.data.profiles[NEW_MEMBER].displayName,
    "New Teammate",
  );
  assert.equal(requests, 6);
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle();
  assert.equal(
    requests,
    6,
    "known profiles must retain the existing focus policy",
  );
});

test("an existing unnamed profile refreshes its name without losing its avatar", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  focusManager.setFocused(true);
  seedCommunity();
  let published = false;
  mockIPC(() => ({
    profiles: {
      [NEW_MEMBER]: {
        ...profile(published ? "New Teammate" : null),
        avatar_url: "https://example.invalid/avatar.png",
      },
    },
    missing: [],
  }));
  const hook = mount([NEW_MEMBER]);
  await settle();
  assert.equal(hook.result.current.data.profiles[NEW_MEMBER].displayName, null);
  published = true;
  await act(async () => context.mock.timers.tick(15_000));
  await settle();
  assert.equal(
    hook.result.current.data.profiles[NEW_MEMBER].displayName,
    "New Teammate",
  );
  assert.equal(
    hook.result.current.data.profiles[NEW_MEMBER].avatarUrl,
    "https://example.invalid/avatar.png",
  );
});

test("a slow name refresh does not get canceled or multiply into overlapping requests", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  focusManager.setFocused(true);
  seedCommunity();
  let requests = 0;
  let finish;
  mockIPC(() => {
    requests += 1;
    if (requests === 1) return { profiles: {}, missing: [NEW_MEMBER] };
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const hook = mount([NEW_MEMBER]);
  await settle();
  await act(async () => context.mock.timers.tick(15_000));
  await settle();
  assert.equal(requests, 2);
  await act(async () => context.mock.timers.tick(60 * 60_000));
  await settle();
  assert.equal(requests, 2);
  finish({ profiles: { [NEW_MEMBER]: profile("New Teammate") }, missing: [] });
  await settle();
  assert.equal(
    hook.result.current.data.profiles[NEW_MEMBER].displayName,
    "New Teammate",
  );
});

test("a failed refresh remains an error, stops its timer, and recovers on focus", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  focusManager.setFocused(true);
  seedCommunity();
  let mode = "missing";
  let requests = 0;
  mockIPC(() => {
    requests += 1;
    if (mode === "error") throw "relay unavailable";
    return mode === "ready"
      ? { profiles: { [NEW_MEMBER]: profile("New Teammate") }, missing: [] }
      : { profiles: {}, missing: [NEW_MEMBER] };
  });
  const hook = mount([NEW_MEMBER]);
  await settle();
  mode = "error";
  await act(async () => context.mock.timers.tick(15_000));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  });
  await settle();
  assert.equal(requests, 5);
  assert.equal(
    hook.result.current.isError,
    true,
    JSON.stringify(hook.client.getQueryState(["users-batch", NEW_MEMBER])),
  );
  await act(async () => context.mock.timers.tick(60 * 60_000));
  await settle();
  assert.equal(requests, 5);
  mode = "ready";
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle();
  assert.equal(hook.result.current.isSuccess, true);
  assert.equal(
    hook.result.current.data.profiles[NEW_MEMBER].displayName,
    "New Teammate",
  );
});

test("a retired community's in-flight response cannot populate profile entries or saved labels", async () => {
  seedCommunity();
  let finish;
  mockIPC(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const hook = mount([NEW_MEMBER]);
  await settle();
  hook.unmount();
  finish({ profiles: { [NEW_MEMBER]: profile("New Teammate") }, missing: [] });
  await settle();
  assert.equal(
    hook.client.getQueryData(usersBatchEntryKey(NEW_MEMBER)),
    undefined,
  );
  assert.equal(readCachedUserLabels(RELAY, [NEW_MEMBER]), undefined);
});
