import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { combineObserverIngestionAgents } from "./useAgentObserverIngestion.ts";

const ME = "aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234";
const OTHER =
  "bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321bbbb4321";
const AGENT_LOCAL =
  "cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111cccc1111";
const AGENT_REMOTE =
  "dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222dddd2222";
const AGENT_FOREIGN =
  "eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333eeee3333";

describe("combineObserverIngestionAgents", () => {
  it("keeps managed agents with their real status", () => {
    const result = combineObserverIngestionAgents(
      [{ pubkey: AGENT_LOCAL, status: "running" }],
      [],
      ME,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_LOCAL, status: "running" }]);
  });

  it("adds declared-owned relay agents as deployed", () => {
    const result = combineObserverIngestionAgents(
      [],
      [{ pubkey: AGENT_REMOTE, ownerPubkey: ME }],
      ME,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_REMOTE, status: "deployed" }]);
  });

  it("excludes relay agents owned by someone else", () => {
    const result = combineObserverIngestionAgents(
      [],
      [{ pubkey: AGENT_FOREIGN, ownerPubkey: OTHER }],
      ME,
    );
    assert.deepEqual(result, []);
  });

  it("excludes relay agents with no declared owner", () => {
    const result = combineObserverIngestionAgents(
      [],
      [{ pubkey: AGENT_REMOTE, ownerPubkey: null }],
      ME,
    );
    assert.deepEqual(result, []);
  });

  it("does not duplicate an agent that is both managed and on the relay", () => {
    const result = combineObserverIngestionAgents(
      [{ pubkey: AGENT_LOCAL, status: "stopped" }],
      [{ pubkey: AGENT_LOCAL, ownerPubkey: ME }],
      ME,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_LOCAL, status: "stopped" }]);
  });

  it("matches ownership case-insensitively", () => {
    const result = combineObserverIngestionAgents(
      [],
      [
        {
          pubkey: AGENT_REMOTE.toUpperCase(),
          ownerPubkey: ME.toUpperCase(),
        },
      ],
      ME,
    );
    assert.deepEqual(result, [
      { pubkey: AGENT_REMOTE.toUpperCase(), status: "deployed" },
    ]);
  });

  it("returns only managed agents when identity is not resolved yet", () => {
    const result = combineObserverIngestionAgents(
      [{ pubkey: AGENT_LOCAL, status: "running" }],
      [{ pubkey: AGENT_REMOTE, ownerPubkey: ME }],
      undefined,
    );
    assert.deepEqual(result, [{ pubkey: AGENT_LOCAL, status: "running" }]);
  });
});
