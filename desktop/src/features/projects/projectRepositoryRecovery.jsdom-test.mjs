import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { relayClient } from "@/shared/api/relayClient";
import {
  beginRelayOriginFetch,
  getCachedRelayOrigin,
  resetMediaCaches,
} from "@/shared/lib/mediaUrl";
import { fetchProjects, fetchProjectHomeForChannel } from "./projectFetch.ts";
import { useProjectQuery, useProjectRepoSnapshotQuery } from "./hooks.ts";
import { buildProjectReadModels } from "./projectModels.ts";

const OWNER = "a".repeat(64);
const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://repository-recovery.example.invalid";
const ADDRESS = `30617:${OWNER}:empty-repo`;
const PROJECT = `30621:${OWNER}:empty-repo`;
const EVENTS = [
  {
    kind: 30621,
    id: "1".repeat(64),
    pubkey: OWNER,
    created_at: 1,
    content: "",
    tags: [
      ["d", "empty-repo"],
      ["buzz-channel", CHANNEL],
      ["a", ADDRESS],
    ],
  },
  {
    kind: 30617,
    id: "2".repeat(64),
    pubkey: OWNER,
    created_at: 1,
    content: "",
    tags: [
      ["d", "empty-repo"],
      ["buzz-channel", CHANNEL],
    ],
  },
];
const clients = new Set();

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.clear();
  resetMediaCaches();
  clearMocks();
  localStorage.clear();
});

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function eventsFor(kinds) {
  return EVENTS.filter((event) => kinds.includes(event.kind));
}

function nativeBoundary(origin, snapshots = []) {
  const calls = [];
  mockIPC((command, args) => {
    calls.push(command);
    if (command === "get_identity") return { pubkey: OWNER };
    if (command === "get_relay_http_url") return origin;
    if (command === "get_project_repo_snapshot") {
      snapshots.push(args.cloneUrl);
      return { latest_commit: null, commits: [], files: [], contributors: [] };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  return calls;
}

test("a cached no-clone project recovers its real empty repository when the relay origin resolves", async (context) => {
  resetMediaCaches();
  const origin = deferred();
  const snapshots = [];
  nativeBoundary(origin.promise, snapshots);
  context.mock.method(relayClient, "fetchEvents", async (filter) =>
    eventsFor(filter.kinds),
  );
  const cached = buildProjectReadModels({
    projectEvents: [EVENTS[0]],
    repositoryEvents: [EVENTS[1]],
    relayOrigin: null,
    viewerPubkey: OWNER,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.add(client);
  client.setQueryData(["projects"], cached, { updatedAt: 0 });
  const hook = renderHook(
    () => {
      const project = useProjectQuery(PROJECT);
      const repository = project.data?.repositories[0];
      const snapshot = useProjectRepoSnapshotQuery(repository);
      return { project, repository, snapshot };
    },
    {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    },
  );
  assert.deepEqual(hook.result.current.repository.cloneUrls, []);
  assert.equal(hook.result.current.snapshot.isPending, true);
  assert.deepEqual(snapshots, []);
  await act(async () => origin.resolve(ORIGIN));
  await waitFor(() =>
    assert.equal(hook.result.current.snapshot.isSuccess, true),
  );
  assert.deepEqual(snapshots, [`${ORIGIN}/git/${OWNER}/empty-repo`]);
  assert.deepEqual(hook.result.current.snapshot.data.files, []);
  assert.equal(hook.result.current.snapshot.data.latestCommit, null);
  await act(async () => {
    await hook.result.current.project.refetch();
    await hook.result.current.snapshot.refetch();
  });
  assert.equal(hook.result.current.snapshot.isError, false);
  assert.equal(snapshots.length, 2);
});

test("scoped project-home discovery resolves the native origin while retaining explicit GitHub remotes", async (context) => {
  resetMediaCaches();
  const calls = nativeBoundary(ORIGIN);
  const github = "https://github.com/Snap-Fusion-GmbH/fixture.git";
  context.mock.method(relayClient, "fetchEvents", async (filter) =>
    eventsFor(filter.kinds).map((event) =>
      event.kind === 30617
        ? { ...event, tags: [...event.tags, ["clone", github]] }
        : event,
    ),
  );
  const project = await fetchProjectHomeForChannel(CHANNEL);
  assert.deepEqual(project.repositories[0].cloneUrls, [github]);
  assert.ok(calls.includes("get_relay_http_url"));
});

test("origin lookup failures remain retryable project errors, not authoritative no-clone success", async () => {
  resetMediaCaches();
  nativeBoundary(Promise.reject(new Error("Native origin lookup unavailable")));
  await assert.rejects(
    fetchProjects(async (kinds) => eventsFor(kinds)),
    /origin lookup unavailable/,
  );
  assert.equal(getCachedRelayOrigin(), null);
});

test("a stalled native origin lookup has a bounded retryable failure", async (context) => {
  resetMediaCaches();
  context.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: 1_800_000_000_000,
  });
  nativeBoundary(new Promise(() => {}));
  const request = assert.rejects(
    fetchProjects(async (kinds) => eventsFor(kinds)),
    /Could not resolve the relay address/,
  );
  context.mock.timers.tick(5_000);
  await request;
});

test("cancelled and retired-community discoveries cannot publish an origin or return authoritative project data", async () => {
  for (const retirement of ["abort", "community-switch"]) {
    resetMediaCaches();
    const origin = deferred();
    nativeBoundary(origin.promise);
    const controller = new AbortController();
    const request = fetchProjects(
      async (kinds) => eventsFor(kinds),
      controller.signal,
    );
    const rejected = assert.rejects(request, /abort|workspace changed/i);
    if (retirement === "abort") {
      controller.abort();
    } else {
      resetMediaCaches();
      beginRelayOriginFetch()("https://next-community.example.invalid");
    }
    origin.resolve(ORIGIN);
    await rejected;
    assert.equal(
      getCachedRelayOrigin(),
      retirement === "abort" ? null : "https://next-community.example.invalid",
    );
  }
});

test("a discovery retired during enumeration cannot return data into the next community", async () => {
  for (const retirement of ["abort", "community-switch"]) {
    resetMediaCaches();
    beginRelayOriginFetch()(ORIGIN);
    nativeBoundary(ORIGIN);
    const announcements = deferred();
    const started = deferred();
    const controller = new AbortController();
    const request = fetchProjects(async (kinds) => {
      if (kinds.includes(30621)) {
        started.resolve();
        return announcements.promise;
      }
      return eventsFor(kinds);
    }, controller.signal);
    const rejected = assert.rejects(request, /abort|workspace changed/i);
    await started.promise;
    if (retirement === "abort") {
      controller.abort();
    } else {
      resetMediaCaches();
      beginRelayOriginFetch()("https://next-community.example.invalid");
    }
    announcements.resolve([EVENTS[0]]);
    await rejected;
  }
});
