import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { waitForAnimations } from "../../../desktop/tests/helpers/animations";

const previewPort = Number(process.env.BUZZ_WEB_E2E_PORT || 4173);
test.use({ baseURL: `http://127.0.0.1:${previewPort + 1}` });
const { basic } = JSON.parse(
  readFileSync(
    new URL(
      "../../../desktop/packages/markdown-math/test-fixtures/basic.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { basic: string };

for (const width of [1280, 390]) {
  for (const surface of ["readme", "file"] as const) {
    test(`web ${surface} renders equations and literal code at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 1000 });
      const path =
        surface === "readme"
          ? "/repos/buzz-desktop"
          : "/repos/buzz-desktop/blob/README.md";
      await page.goto(`${path}?preview=repositories`);
      const prose = page.locator(".prose").filter({ hasText: "Physics notes" });
      await expect(prose.locator(".katex")).toHaveCount(2);
      await expect(prose.locator(".katex-display")).toHaveCount(1);
      await expect(prose).toContainText("Budget: $5 and $10.");
      await expect(prose.locator("code").first()).toHaveText(
        "price $5 and $10",
      );
      await expect(prose.locator("pre")).toContainText(
        "$E=mc^2$ is literal source here",
      );
      const metrics = await prose.evaluate(async (element) => {
        await document.fonts.ready;
        return {
          fontsLoaded: Array.from(document.fonts).some(
            (font) => font.family.includes("KaTeX") && font.status === "loaded",
          ),
          width: element.clientWidth,
          scrollWidth: element.scrollWidth,
          pageWidth: document.documentElement.clientWidth,
          pageScrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(metrics.fontsLoaded).toBe(true);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
      expect(metrics.pageScrollWidth).toBeLessThanOrEqual(
        metrics.pageWidth + 1,
      );
      if (surface === "readme") {
        await waitForAnimations(page);
        await prose.screenshot({
          path: testInfo.outputPath(`web-math-${width}.png`),
        });
      }
    });
  }
}

test("invite policy uses the same bounded math renderer", async ({ page }) => {
  await page.route("**/api/join-policy", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: {
          terms_markdown: basic,
          privacy_markdown: "Privacy.",
          age_attestation_required: true,
          version: "math-policy",
        },
      }),
    });
  });
  await page.route("https://api.github.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "[]",
    });
  });
  await page.goto("/invite/math-policy");
  await page.getByRole("button", { name: "Terms of Service" }).click();
  const dialog = page.getByRole("dialog", { name: "Terms of Service" });
  await expect(dialog.locator(".katex")).toHaveCount(2);
  await expect(dialog).toContainText("Budget: $5 and $10.");
  await expect(dialog.locator("code").first()).toHaveText("price $5 and $10");
});

test("wide inline math stays contained and keyboard-scrollable on mobile web", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/repos/buzz-desktop?preview=repositories&math=wide");
  const prose = page.locator(".prose").filter({ hasText: "Inline matrix" });
  const equation = prose.locator(".katex");
  await expect(equation).toBeVisible();
  const metrics = await prose.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    pageWidth: document.documentElement.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
  expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageWidth + 1);
  await equation.focus();
  await expect(equation).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => equation.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});
