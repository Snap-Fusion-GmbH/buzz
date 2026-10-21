import assert from "node:assert/strict";
import { test } from "node:test";
import { mockIPC } from "@tauri-apps/api/mocks";
import { createProject } from "./createProject.ts";
import { relayClient } from "@/shared/api/relayClient";
import { resetMediaCaches } from "@/shared/lib/mediaUrl";

const repository = {
  id: "6001",
  fullName: "Snap-Fusion-GmbH/private-demo",
  private: true,
  cloneUrl: "https://github.com/Snap-Fusion-GmbH/private-demo.git",
  webUrl: "https://github.com/Snap-Fusion-GmbH/private-demo",
  defaultBranch: "main",
  canPush: true,
  archived: false,
};

function resume() {
  return { channels: new Map(), projectIds: new Set() };
}

test("the production create operation rejects unconsented GitHub metadata before any native I/O", async () => {
  const calls = [];
  mockIPC((command) => {
    calls.push(command);
    throw new Error("Unexpected native I/O");
  });
  await assert.rejects(
    createProject(
      { name: "private-demo", githubRepository: repository },
      resume(),
    ),
    /Confirm sharing/,
  );
  assert.deepEqual(calls, []);
});

test("a stale identity after GitHub access verification cannot publish to another workspace", async () => {
  let pubkey = "a".repeat(64);
  const calls = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "get_identity") return { pubkey, display_name: "Fixture" };
    if (command === "get_github_repository") {
      pubkey = "b".repeat(64);
      return repository;
    }
    throw new Error("Unexpected project write");
  });
  await assert.rejects(
    createProject(
      {
        name: "private-demo",
        githubRepository: repository,
        shareGitHubMetadata: true,
      },
      resume(),
    ),
    /active workspace changed/,
  );
  assert.deepEqual(calls, [
    "get_identity",
    "get_github_repository",
    "get_identity",
  ]);
});

test("a repository rename cannot silently change the metadata the user consented to share", async () => {
  const calls = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "get_identity")
      return { pubkey: "a".repeat(64), display_name: "Fixture" };
    if (command === "get_github_repository")
      return {
        ...repository,
        fullName: "Snap-Fusion-GmbH/renamed",
        cloneUrl: "https://github.com/Snap-Fusion-GmbH/renamed.git",
        webUrl: "https://github.com/Snap-Fusion-GmbH/renamed",
      };
    throw new Error("Unexpected project write");
  });
  await assert.rejects(
    createProject(
      {
        name: "private-demo",
        githubRepository: repository,
        shareGitHubMetadata: true,
      },
      resume(),
    ),
    /repository changed/,
  );
  assert.deepEqual(calls, [
    "get_identity",
    "get_github_repository",
    "get_identity",
  ]);
});

test("an identity change during project discovery cannot start a private GitHub project write", async (t) => {
  let pubkey = "a".repeat(64);
  const writes = [];
  t.mock.method(relayClient, "fetchEvents", async () => {
    pubkey = "b".repeat(64);
    return [];
  });
  mockIPC((command) => {
    if (command === "get_identity") return { pubkey, display_name: "Fixture" };
    if (command === "get_github_repository") return repository;
    writes.push(command);
    throw new Error("Unexpected project write");
  });
  await assert.rejects(
    createProject(
      {
        name: "private-demo",
        githubRepository: repository,
        shareGitHubMetadata: true,
      },
      resume(),
    ),
    /active workspace changed/,
  );
  assert.deepEqual(writes, []);
});

test("a workspace reset during project discovery is fenced even when its origin and identity match again", async (t) => {
  const writes = [];
  t.mock.method(relayClient, "fetchEvents", async () => {
    resetMediaCaches();
    return [];
  });
  mockIPC((command) => {
    if (command === "get_identity")
      return { pubkey: "a".repeat(64), display_name: "Fixture" };
    if (command === "get_github_repository") return repository;
    writes.push(command);
    throw new Error("Unexpected project write");
  });
  await assert.rejects(
    createProject(
      {
        name: "private-demo",
        githubRepository: repository,
        shareGitHubMetadata: true,
      },
      resume(),
    ),
    /active workspace changed/,
  );
  assert.deepEqual(writes, []);
});

for (const boundary of ["signing", "project-publication"]) {
  test(`a workspace reset during ${boundary} cannot publish further GitHub metadata`, async (t) => {
    const published = [];
    t.mock.method(relayClient, "fetchEvents", async () => []);
    t.mock.method(relayClient, "publishEvent", async (event) => {
      published.push(event.kind);
      if (boundary === "project-publication") resetMediaCaches();
    });
    mockIPC((command, payload) => {
      if (command === "get_identity")
        return { pubkey: "a".repeat(64), display_name: "Fixture" };
      if (command === "get_github_repository") return repository;
      if (command === "create_channel")
        return {
          id: "a4aef0d7-8cf4-47ae-90f1-b98bfb256b97",
          name: "private-demo",
          channel_type: "stream",
          visibility: "private",
        };
      if (command === "sign_event") {
        if (boundary === "signing") resetMediaCaches();
        return JSON.stringify({
          ...payload,
          pubkey: "a".repeat(64),
          id: "c".repeat(64),
          created_at: 1_792_577_600,
          sig: "d".repeat(128),
        });
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
    await assert.rejects(
      createProject(
        {
          name: "private-demo",
          githubRepository: repository,
          shareGitHubMetadata: true,
        },
        resume(),
      ),
      /active workspace changed/,
    );
    assert.deepEqual(published, boundary === "signing" ? [] : [30621]);
  });
}
