import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const { basic } = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/markdown-math/test-fixtures/basic.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { basic: string };

async function waitForMockLiveSubscription(page: Page, channelName: string) {
  await page.waitForFunction(
    (name) =>
      window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName: name }),
    channelName,
  );
}

async function emitMath(page: Page, content = basic) {
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await waitForMockLiveSubscription(page, "general");
  const id = await page.evaluate((body) => {
    const message = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: body,
    });
    if (!message) throw new Error("Math fixture was not delivered");
    return message.id;
  }, content);
  const message = page
    .getByTestId("message-timeline")
    .locator(`[data-message-id="${id}"]`);
  await expect(message).toBeVisible();
  return { id, message };
}

for (const theme of ["light", "dark"] as const) {
  test(`math renders with bundled fonts and literal code in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.addInitScript((value) => {
      localStorage.setItem("buzz-theme", value);
    }, theme);
    await installMockBridge(page);
    await page.goto("/");
    const { message } = await emitMath(page);
    const markdown = message.locator(".message-markdown");
    await expect(markdown.locator(".katex")).toHaveCount(2);
    await expect(markdown.locator(".katex-display")).toHaveCount(1);
    await expect(markdown.locator("math")).toHaveCount(2);
    for (const visual of await markdown.locator(".katex-html").all()) {
      await expect(visual).toHaveAttribute("aria-hidden", "true");
    }
    if (theme === "dark") {
      await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    }
    await expect(markdown).toContainText("Budget: $5 and $10.");
    await expect(markdown.locator("code").first()).toHaveText(
      "price $5 and $10",
    );
    await expect(markdown.locator("pre")).toContainText(
      "$E=mc^2$ is literal source here",
    );
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      return Array.from(document.fonts)
        .filter((font) => font.family.includes("KaTeX"))
        .map((font) => ({ family: font.family, status: font.status }));
    });
    expect(fonts.some((font) => font.status === "loaded")).toBe(true);
    expect(fonts.some((font) => font.status === "error")).toBe(false);
    const size = await markdown
      .locator(".katex")
      .first()
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "20px";
    });
    await expect
      .poll(() =>
        markdown
          .locator(".katex")
          .first()
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize),
          ),
      )
      .toBeGreaterThan(size);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.mouse.move(0, 0);
    await waitForAnimations(page);
    await markdown.screenshot({
      path: testInfo.outputPath(`math-${theme}.png`),
    });
  });
}

test("wide display equations stay inside a narrow thread", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installMockBridge(page);
  await page.goto("/");
  const wide = Array.from({ length: 30 }, () => "x_{123}").join("\\quad ");
  const { id, message } = await emitMath(
    page,
    `Wide equation\n\n$$\n${wide}\n$$`,
  );
  await message.hover();
  await page.getByTestId(`reply-message-${id}`).click();
  const thread = page.getByTestId("message-thread-panel");
  const equation = thread.locator(".katex-display");
  await expect(equation).toBeVisible();
  const metrics = await equation.evaluate((element) => ({
    width: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflow: getComputedStyle(element).overflowX,
    pageWidth: document.documentElement.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(metrics.width).toBeLessThan(600);
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.width);
  expect(metrics.overflow).toBe("auto");
  expect(metrics.pageScrollWidth).toBeLessThanOrEqual(metrics.pageWidth + 1);
  await equation.focus();
  await expect(equation).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => equation.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.mouse.move(0, 0);
  await waitForAnimations(page);
  await thread.screenshot({ path: testInfo.outputPath("math-thread.png") });
});

test("a wide inline matrix stays locally scrollable", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await installMockBridge(page);
  await page.goto("/");
  const cells = Array.from({ length: 20 }, () => "x_{123}").join(" & ");
  const { message } = await emitMath(
    page,
    `Inline matrix $\\begin{matrix}${cells}\\end{matrix}$.`,
  );
  const equation = message.locator(".katex");
  await expect(equation).toBeVisible();
  const metrics = await message
    .locator(".message-markdown")
    .evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width + 1);
  await equation.focus();
  await expect(equation).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => equation.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});

test("warm channel switches reuse parsed equations", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await emitMath(page);
  async function settle(name: string) {
    await page.getByTestId(`channel-${name}`).click();
    await expect(page.getByTestId("chat-title")).toHaveText(name);
    await expect(page.locator('[data-render-pending="true"]')).toHaveCount(0);
    await page.waitForTimeout(300);
  }
  await settle("random");
  await settle("general");
  const before = await page.evaluate(() =>
    window.__BUZZ_E2E_MD_PARSE_COUNT__?.(),
  );
  expect(before).toBeGreaterThan(0);
  await settle("random");
  await settle("general");
  expect(
    await page.evaluate(() => window.__BUZZ_E2E_MD_PARSE_COUNT__?.()),
  ).toBe(before);
  await expect(
    page.getByTestId("message-timeline").locator(".message-markdown .katex"),
  ).toHaveCount(2);
});
