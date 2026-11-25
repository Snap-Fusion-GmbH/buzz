export const DEPRECATION_BANNER_STORAGE_KEY =
  "buzz.deprecationBanner.dismissedAt";
export const DEPRECATION_BANNER_SNOOZE_MS = 24 * 60 * 60 * 1000;

/**
 * Managed-workspace distributions deliver their own updates, so the banner
 * never advertises the replacement app there. `null` means the build kind is
 * not known yet; render nothing rather than flash the banner. A failed lookup
 * reports `false` so unmanaged builds keep the banner.
 */
export function bannerAllowedForBuild(managedBuild: boolean | null): boolean {
  return managedBuild === false;
}

/** Shown unless dismissed less than a day ago. Evaluated once per mount. */
export function shouldShowDeprecationBanner(
  dismissedAt: string | null,
  now: number,
): boolean {
  const dismissedAtMs = Number(dismissedAt);
  if (!dismissedAt || !Number.isFinite(dismissedAtMs)) {
    return true;
  }
  return now - dismissedAtMs >= DEPRECATION_BANNER_SNOOZE_MS;
}
