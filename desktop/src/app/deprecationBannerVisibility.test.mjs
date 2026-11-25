import assert from "node:assert/strict";
import test from "node:test";

import {
  bannerAllowedForBuild,
  DEPRECATION_BANNER_SNOOZE_MS,
  shouldShowDeprecationBanner,
} from "./deprecationBannerVisibility.ts";

const NOW = 1_800_000_000_000;

test("shows the banner when it was never dismissed", () => {
  assert.equal(shouldShowDeprecationBanner(null, NOW), true);
});

test("shows the banner when the stored value is unreadable", () => {
  assert.equal(shouldShowDeprecationBanner("garbage", NOW), true);
});

test("hides the banner within a day of dismissal", () => {
  const dismissedAt = String(NOW - DEPRECATION_BANNER_SNOOZE_MS + 1);
  assert.equal(shouldShowDeprecationBanner(dismissedAt, NOW), false);
});

test("shows the banner again once a day has passed", () => {
  const dismissedAt = String(NOW - DEPRECATION_BANNER_SNOOZE_MS);
  assert.equal(shouldShowDeprecationBanner(dismissedAt, NOW), true);
});

test("managed-workspace builds never show the banner; unknown builds wait", () => {
  for (const [managedBuild, allowed] of [
    [true, false],
    [null, false],
    [false, true],
  ]) {
    assert.equal(
      bannerAllowedForBuild(managedBuild),
      allowed,
      String(managedBuild),
    );
  }
});
