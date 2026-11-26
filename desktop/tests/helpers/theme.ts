import type { Page } from "@playwright/test";

/**
 * Pin the stored theme before the app mounts. Tests about one theme's look
 * pin it rather than depend on the app's default theme, which can change.
 * Call before `installMockBridge(page)`.
 */
export async function pinTheme(page: Page, theme: string): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem("buzz-theme", value);
  }, theme);
}
