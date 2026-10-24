/**
 * Names of the channels earlier releases seeded on a fresh installation.
 * Nothing seeds them any more; existing installations retire them once per
 * identity and community.
 */
export const RETIRED_STARTER_GENERAL_CHANNEL_NAME = "general";
export const RETIRED_STARTER_WELCOME_CHANNEL_NAME = "welcome-everyone";
export const RETIRED_PRIVATE_WELCOME_CHANNEL_NAME = "Welcome";

const WELCOME_CHANNELS_RETIRED_STORAGE_KEY = "buzz-welcome-channels-retired.v1";

export function welcomeChannelsRetiredStorageKey(
  pubkey: string,
  communityScope: string,
) {
  return `${WELCOME_CHANNELS_RETIRED_STORAGE_KEY}:${encodeURIComponent(
    communityScope,
  )}:${pubkey}`;
}

export function hasRetiredWelcomeChannels(
  pubkey: string | null | undefined,
  communityScope: string | null | undefined,
) {
  if (typeof window === "undefined" || !pubkey || !communityScope) {
    return false;
  }

  try {
    return (
      window.localStorage.getItem(
        welcomeChannelsRetiredStorageKey(pubkey, communityScope),
      ) === "true"
    );
  } catch {
    return false;
  }
}

/**
 * Best-effort: a failed mark only re-runs an idempotent retirement. The marker
 * is written only after the relay accepted every write, so a partial failure
 * is retried on the next start rather than being recorded as done.
 */
export function markWelcomeChannelsRetired(
  pubkey: string | null | undefined,
  communityScope: string | null | undefined,
) {
  if (typeof window === "undefined" || !pubkey || !communityScope) {
    return;
  }

  try {
    window.localStorage.setItem(
      welcomeChannelsRetiredStorageKey(pubkey, communityScope),
      "true",
    );
  } catch {
    // Storage denied: retirement just runs again next start.
  }
}
