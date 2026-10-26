import type { Channel } from "@/shared/api/types";

export const WELCOME_CHANNEL_NAME = "Welcome";
export const STARTER_WELCOME_CHANNEL_NAME = "welcome-everyone";
export const WELCOME_SURFACE_READY_EVENT =
  "buzz:onboarding-welcome-surface-ready";

const WELCOME_INITIAL_UNREAD_SUPPRESSION_STORAGE_KEY =
  "buzz:onboarding-welcome-initial-unread-suppression.v1";
const PENDING_WELCOME_CHANNEL_MAX_AGE_MS = 5 * 60 * 1000;

type PendingWelcomeChannel = {
  channelId: string;
  createdAt: number;
};

function normalizeChannelName(name: string) {
  return name.trim().toLowerCase();
}

export function isWelcomeChannel(channel: Channel | null | undefined) {
  return (
    channel !== null &&
    channel !== undefined &&
    channel.name === WELCOME_CHANNEL_NAME &&
    channel.channelType === "stream" &&
    channel.visibility === "private"
  );
}

export function isStarterWelcomeChannel(channel: Channel | null | undefined) {
  return (
    channel !== null &&
    channel !== undefined &&
    normalizeChannelName(channel.name) === STARTER_WELCOME_CHANNEL_NAME &&
    channel.channelType === "stream" &&
    channel.visibility === "open"
  );
}

/**
 * Channels that still get the welcome experience (intro action cards, guide
 * composer banner, chat-first agent creation). Clients no longer seed these,
 * but installations whose retirement has not landed yet can still have them.
 */
export function isWelcomeExperienceChannel(
  channel: Channel | null | undefined,
) {
  return isWelcomeChannel(channel) || isStarterWelcomeChannel(channel);
}

function readPendingWelcomeChannelFromStorage(
  storageKey: string,
): PendingWelcomeChannel | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PendingWelcomeChannel>;
    if (
      typeof parsed.channelId !== "string" ||
      parsed.channelId.length === 0 ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }

    return {
      channelId: parsed.channelId,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function clearPendingWelcomeChannelFromStorage(storageKey: string) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Best-effort. A stale pending channel expires automatically.
  }
}

export function hasPendingWelcomeInitialUnreadSuppression(channelId: string) {
  const pending = readPendingWelcomeChannelFromStorage(
    WELCOME_INITIAL_UNREAD_SUPPRESSION_STORAGE_KEY,
  );
  if (!pending) {
    return false;
  }

  if (Date.now() - pending.createdAt > PENDING_WELCOME_CHANNEL_MAX_AGE_MS) {
    return false;
  }

  return pending.channelId === channelId;
}

export function consumePendingWelcomeInitialUnreadSuppression(
  channelId: string,
) {
  if (!hasPendingWelcomeInitialUnreadSuppression(channelId)) {
    return false;
  }

  clearPendingWelcomeChannelFromStorage(
    WELCOME_INITIAL_UNREAD_SUPPRESSION_STORAGE_KEY,
  );
  return true;
}

/**
 * Announce that the Welcome channel screen has rendered with settled timeline
 * data.
 */
export function notifyWelcomeSurfaceReady(channelId: string) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(WELCOME_SURFACE_READY_EVENT, {
      detail: { channelId },
    }),
  );
}
