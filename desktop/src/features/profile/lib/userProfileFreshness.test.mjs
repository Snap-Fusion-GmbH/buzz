import assert from "node:assert/strict";
import test from "node:test";

import {
  hasResolvedUserProfileLabel,
  isUsersBatchEntryFresh,
  MISSING_USER_PROFILE_FRESH_MS,
  missingProfileRefetchInterval,
  USERS_BATCH_ENTRY_FRESH_MS,
  unresolvedUserProfilePubkeys,
} from "./userProfileFreshness.ts";

test("negative profile entries expire quickly without shortening real profile caching", () => {
  const now = 1_800_000_000_000;
  for (const [summary, lifetime] of [
    [null, MISSING_USER_PROFILE_FRESH_MS],
    [
      { displayName: null, avatarUrl: "/avatar" },
      MISSING_USER_PROFILE_FRESH_MS,
    ],
    [{ displayName: "Alice" }, USERS_BATCH_ENTRY_FRESH_MS],
  ]) {
    for (const [age, expected] of [
      [-1, false],
      [0, true],
      [lifetime - 1, true],
      [lifetime, false],
      [lifetime + 1, false],
      [Number.NaN, false],
    ]) {
      assert.equal(
        isUsersBatchEntryFresh({ summary, fetchedAt: now - age }, now),
        expected,
        `summary=${Boolean(summary)}, age=${age}`,
      );
    }
  }
  assert.equal(isUsersBatchEntryFresh(undefined, now), false);
});

test("empty and raw-key profiles remain unresolved without dropping other profile metadata", () => {
  const pubkey = "b".repeat(64);
  for (const [summary, resolved] of [
    [null, false],
    [{ displayName: "  ", avatarUrl: "/avatar" }, false],
    [{ displayName: pubkey }, false],
    [{ displayName: "New Teammate" }, true],
    [{ name: "new-teammate" }, true],
    [{ nip05Handle: "new-teammate@example.invalid" }, true],
  ]) {
    assert.equal(hasResolvedUserProfileLabel(summary, pubkey), resolved);
    assert.deepEqual(
      unresolvedUserProfilePubkeys({
        profiles: summary ? { [pubkey]: summary } : {},
        missing: summary ? [] : [pubkey],
      }),
      resolved ? [] : [pubkey],
    );
  }
  assert.deepEqual(unresolvedUserProfilePubkeys(undefined), []);
});

test("missing-profile background retries back off and have a terminal bound", () => {
  for (const [reads, interval] of [
    [0, false],
    [1, 15_000],
    [2, 30_000],
    [3, 60_000],
    [4, 120_000],
    [5, false],
    [100, false],
  ]) {
    assert.equal(missingProfileRefetchInterval(["missing"], reads), interval);
    assert.equal(missingProfileRefetchInterval([], reads), false);
    assert.equal(missingProfileRefetchInterval(undefined, reads), false);
  }
});
