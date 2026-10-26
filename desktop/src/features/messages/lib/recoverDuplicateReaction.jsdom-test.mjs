import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { useToggleReactionMutation } from "../hooks.ts";
import { relayClient } from "@/shared/api/relayClient";
import { formatTimelineMessages } from "./formatTimelineMessages.ts";
import { channelMessagesKey, channelWindowKey } from "./messageQueryKeys.ts";
import {
  emptyChannelWindowStore,
  mergeLiveChannelWindowEvent,
} from "./channelWindowStore.ts";
import { projectChannelWindowMessages } from "./projectChannelWindow.ts";

const PUBLIC_KEY = "a".repeat(64);
const MESSAGE = {
  id: "1".repeat(64),
  kind: 9,
  pubkey: PUBLIC_KEY,
  content: "Fixture message",
  created_at: 1000,
  tags: [["h", "general"]],
  sig: "fixture",
};
const REACTION = {
  ...MESSAGE,
  id: "2".repeat(64),
  kind: 7,
  content: "👀",
  tags: [["e", MESSAGE.id]],
};
const DUPLICATE = "relay rejected event: duplicate: reaction already exists";

afterEach(() => {
  cleanup();
  clearMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  client.setQueryData(["identity"], { pubkey: PUBLIC_KEY });
  client.setQueryData(channelMessagesKey("general"), [MESSAGE]);
  client.setQueryData(
    channelWindowKey("general"),
    mergeLiveChannelWindowEvent(emptyChannelWindowStore(), MESSAGE),
  );
  const hook = renderHook(() => useToggleReactionMutation(), {
    wrapper: ({ children }) =>
      React.createElement(QueryClientProvider, { client }, children),
  });
  return { ...hook, client };
}

function mockReactionIPC(handler) {
  mockIPC((command, payload) => {
    if (command === "get_relay_http_url") return "https://relay.example";
    if (command === "get_media_proxy_port") return 54321;
    return handler(command, payload);
  });
}

async function toggle(hook, remove = false) {
  await act(() =>
    hook.result.current.mutateAsync({
      eventId: MESSAGE.id,
      emoji: "👀",
      remove,
    }),
  );
}

test("a duplicate add reads the existing reaction, survives window projection, and can be removed", {
  timeout: 10_000,
}, async (context) => {
  const commands = [];
  mockReactionIPC((command, payload) => {
    commands.push({ command, payload });
    if (command === "add_reaction") throw DUPLICATE;
    if (command === "remove_reaction") return;
    throw new Error(`Unexpected command: ${command}`);
  });
  const requests = [];
  context.mock.method(relayClient, "fetchEvents", async (filter) => {
    requests.push(filter);
    return [REACTION];
  });
  const hook = mount();
  await toggle(hook);
  projectChannelWindowMessages(hook.client, "general");
  const messages = formatTimelineMessages(
    hook.client.getQueryData(channelMessagesKey("general")),
    null,
    PUBLIC_KEY,
    null,
  );
  assert.equal(messages[0].reactions[0].count, 1);
  assert.equal(messages[0].reactions[0].reactedByCurrentUser, true);
  assert.deepEqual(requests, [
    { kinds: [7], authors: [PUBLIC_KEY], "#e": [MESSAGE.id], limit: 500 },
  ]);
  await toggle(hook, true);
  assert.deepEqual(
    commands.map(({ command }) => command),
    ["add_reaction", "remove_reaction"],
  );
});

test("duplicate recovery requires an authoritative matching reaction and propagates read failures", {
  timeout: 10_000,
}, async (context) => {
  mockReactionIPC(() => {
    throw DUPLICATE;
  });
  let response = [];
  context.mock.method(relayClient, "fetchEvents", async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const hook = mount();
  for (response of [
    [],
    [{ ...REACTION, pubkey: "b".repeat(64) }],
    [{ ...REACTION, content: "👍" }],
    [{ ...REACTION, tags: [["e", "3".repeat(64)]] }],
    new Error("relay unavailable"),
  ]) {
    await assert.rejects(toggle(hook));
    assert.deepEqual(hook.client.getQueryData(channelMessagesKey("general")), [
      MESSAGE,
    ]);
  }
});

test("real permission errors are not treated as duplicate success", {
  timeout: 10_000,
}, async (context) => {
  mockReactionIPC(() => {
    throw "relay rejected event: restricted: not a relay member";
  });
  const read = context.mock.method(relayClient, "fetchEvents", async () => []);
  const hook = mount();
  await assert.rejects(toggle(hook), /not a relay member/);
  assert.equal(read.mock.callCount(), 0);
});

test("a late duplicate acknowledgement cannot read or update a different community", {
  timeout: 10_000,
}, async (context) => {
  let reject;
  mockReactionIPC(
    () =>
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      }),
  );
  const read = context.mock.method(relayClient, "fetchEvents", async () => [
    REACTION,
  ]);
  const hook = mount();
  let pending;
  await act(async () => {
    pending = hook.result.current.mutateAsync({
      eventId: MESSAGE.id,
      emoji: "👀",
      remove: false,
    });
    await Promise.resolve();
  });
  hook.unmount();
  const rejected = assert.rejects(pending, /duplicate/);
  reject(DUPLICATE);
  await rejected;
  assert.equal(read.mock.callCount(), 0);
  assert.deepEqual(hook.client.getQueryData(channelMessagesKey("general")), [
    MESSAGE,
  ]);
});
