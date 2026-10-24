import assert from "node:assert/strict";
import test from "node:test";

import {
  isStarterWelcomeChannel,
  isWelcomeChannel,
  isWelcomeExperienceChannel,
} from "./welcome.ts";
import {
  hasRetiredWelcomeChannels,
  markWelcomeChannelsRetired,
  welcomeChannelsRetiredStorageKey,
} from "./welcomeChannelsRetirement.ts";

function makeChannel(overrides = {}) {
  return {
    id: "welcome-channel",
    name: "Welcome",
    channelType: "stream",
    visibility: "private",
    description: "",
    topic: null,
    purpose: null,
    memberCount: 1,
    memberPubkeys: ["current-user"],
    lastMessageAt: null,
    archivedAt: null,
    participants: [],
    participantPubkeys: [],
    isMember: true,
    ttlSeconds: null,
    ttlDeadline: null,
    ...overrides,
  };
}

function installWindowStorage() {
  const local = new Map();
  const previousWindow = globalThis.window;

  globalThis.window = {
    localStorage: {
      getItem(key) {
        return local.get(key) ?? null;
      },
      setItem(key, value) {
        local.set(key, String(value));
      },
    },
  };

  return {
    restore() {
      if (previousWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
    },
  };
}

test("only the legacy private stream named Welcome is the welcome channel", () => {
  assert.equal(isWelcomeChannel(makeChannel()), true);
  assert.equal(isWelcomeChannel(makeChannel({ visibility: "open" })), false);
  assert.equal(isWelcomeChannel(makeChannel({ channelType: "forum" })), false);
  assert.equal(isWelcomeChannel(makeChannel({ name: "welcome" })), false);
  assert.equal(isWelcomeChannel(null), false);
});

test("only the legacy public starter is the starter welcome channel", () => {
  const starter = makeChannel({
    name: "welcome-everyone",
    visibility: "open",
  });

  assert.equal(isStarterWelcomeChannel(starter), true);
  assert.equal(
    isStarterWelcomeChannel({ ...starter, name: " Welcome-Everyone " }),
    true,
  );
  assert.equal(
    isStarterWelcomeChannel({ ...starter, visibility: "private" }),
    false,
  );
  assert.equal(
    isStarterWelcomeChannel({ ...starter, channelType: "forum" }),
    false,
  );
  assert.equal(isStarterWelcomeChannel(undefined), false);
});

test("the welcome experience covers both legacy channels", () => {
  const privateWelcome = makeChannel();
  const starter = makeChannel({
    name: "welcome-everyone",
    visibility: "open",
  });
  const unrelated = makeChannel({ name: "general", visibility: "open" });

  assert.equal(isWelcomeExperienceChannel(privateWelcome), true);
  assert.equal(isWelcomeExperienceChannel(starter), true);
  assert.equal(isWelcomeExperienceChannel(unrelated), false);
  assert.equal(isWelcomeExperienceChannel(null), false);
});

test("retirement marks are scoped per identity and community", () => {
  const storage = installWindowStorage();
  try {
    assert.equal(
      hasRetiredWelcomeChannels("pubkey-a", "wss://community-a.example"),
      false,
    );

    markWelcomeChannelsRetired("pubkey-a", "wss://community-a.example");

    assert.equal(
      hasRetiredWelcomeChannels("pubkey-a", "wss://community-a.example"),
      true,
    );
    assert.equal(
      hasRetiredWelcomeChannels("pubkey-a", "wss://community-b.example"),
      false,
    );
    assert.equal(
      hasRetiredWelcomeChannels("pubkey-b", "wss://community-a.example"),
      false,
    );
    assert.equal(hasRetiredWelcomeChannels("pubkey-a", null), false);
    assert.equal(
      hasRetiredWelcomeChannels(null, "wss://community-a.example"),
      false,
    );
  } finally {
    storage.restore();
  }
});

test("the retirement key survives a partial community scope", () => {
  assert.equal(
    welcomeChannelsRetiredStorageKey("pubkey-a", "wss://community-a.example"),
    "buzz-welcome-channels-retired.v1:wss%3A%2F%2Fcommunity-a.example:pubkey-a",
  );
});
