import type {
  UserProfileSummary,
  UsersBatchResponse,
} from "@/shared/api/types";

/** A relay-confirmed profile or absence, scoped by the community query client. */
export type UsersBatchEntry = {
  summary: UserProfileSummary | null;
  fetchedAt: number;
};

/** Cache key for a single relay-confirmed profile lookup. */
export const usersBatchEntryKey = (pubkey: string) => [
  "users-batch-entry",
  pubkey,
];

/** Freshness of a resolved profile, including its potentially large avatar. */
export const USERS_BATCH_ENTRY_FRESH_MS = 10 * 60_000;

/** Freshness of an absent or unnamed profile before checking for its name again. */
export const MISSING_USER_PROFILE_FRESH_MS = 15_000;

const MISSING_PROFILE_RETRY_DELAYS_MS = [
  MISSING_USER_PROFILE_FRESH_MS,
  MISSING_USER_PROFILE_FRESH_MS * 2,
  MISSING_USER_PROFILE_FRESH_MS * 4,
  MISSING_USER_PROFILE_FRESH_MS * 8,
];

/** Whether a profile provides a readable label rather than its raw public key. */
export function hasResolvedUserProfileLabel(
  profile: UserProfileSummary | null,
  pubkey?: string,
): boolean {
  const label =
    profile?.displayName?.trim() ||
    profile?.nip05Handle?.trim() ||
    profile?.name?.trim();
  return Boolean(label && label.toLowerCase() !== pubkey?.toLowerCase());
}

/** Include existing but unnamed profiles in the bounded name-resolution retry. */
export function unresolvedUserProfilePubkeys(
  data: UsersBatchResponse | undefined,
): string[] {
  if (!data) return [];
  return [
    ...new Set([
      ...data.missing,
      ...Object.entries(data.profiles)
        .filter(
          ([pubkey, profile]) => !hasResolvedUserProfileLabel(profile, pubkey),
        )
        .map(([pubkey]) => pubkey),
    ]),
  ];
}

/** Whether a confirmed lookup can answer without another relay request. */
export function isUsersBatchEntryFresh(
  entry: UsersBatchEntry | undefined,
  now: number,
  pubkey?: string,
): boolean {
  if (!entry) return false;
  const age = now - entry.fetchedAt;
  const lifetime = hasResolvedUserProfileLabel(entry.summary, pubkey)
    ? USERS_BATCH_ENTRY_FRESH_MS
    : MISSING_USER_PROFILE_FRESH_MS;
  return age >= 0 && age < lifetime;
}

/** Bound background resolution attempts; later focus or navigation can retry. */
export function missingProfileRefetchInterval(
  missing: readonly string[] | undefined,
  successfulReads: number,
): number | false {
  if (!missing?.length || successfulReads < 1) return false;
  return MISSING_PROFILE_RETRY_DELAYS_MS[successfulReads - 1] ?? false;
}
