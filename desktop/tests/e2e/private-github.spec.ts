import { expect, test, type Page } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

async function openImport(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "buzz-feature-overrides-v1",
      JSON.stringify({ projects: true }),
    );
    window.__BUZZ_E2E_GITHUB__ = { login: null };
    window.__BUZZ_E2E_ACCEPTED_PROJECT_EVENTS__ = [];
  });
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("sidebar-projects-create").click();
  await page.getByTestId("project-browser-github").click();
  await expect(page.getByTestId("github-import-dialog")).toBeVisible();
}

test("private GitHub import requires consent, recovers access errors and appears in Projects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openImport(page);
  await page.getByTestId("github-connect").click();
  await expect(page.getByTestId("github-account-controls")).toContainText(
    "avery-e",
  );
  await page.getByTestId("github-import-repository").selectOption("6001");
  await expect(page.getByTestId("github-import-name")).toHaveValue(
    "private-demo",
  );
  const submit = page.getByTestId("github-import-submit");
  await expect(submit).toBeDisabled();
  await page
    .getByLabel(
      "Share this repository's name and link with this Buzz workspace",
    )
    .check();
  await expect(submit).toBeEnabled();
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(submit).toBeVisible();
  await expect(page.getByTestId("github-import-repository")).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/private-github/01-import-compact.png",
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  await page.evaluate(() => {
    const state = window.__BUZZ_E2E_GITHUB__;
    if (!state) throw new Error("GitHub fixture is missing");
    state.accessError = "GitHub repository access was denied.";
  });
  await submit.click();
  await expect(page.getByRole("alert")).toContainText(
    "GitHub repository access was denied.",
  );
  await expect(page.getByTestId("sidebar-project-private-demo")).toHaveCount(0);
  const deniedPublications = await page.evaluate(
    () =>
      window.__BUZZ_E2E_ACCEPTED_PROJECT_EVENTS__?.filter((event) =>
        event.tags.some((tag) => tag[0] === "d" && tag[1] === "private-demo"),
      ) ?? [],
  );
  expect(deniedPublications).toEqual([]);

  await page.evaluate(() => {
    const state = window.__BUZZ_E2E_GITHUB__;
    if (!state) throw new Error("GitHub fixture is missing");
    delete state.accessError;
  });
  await submit.click();
  await expect(page.getByTestId("github-import-dialog")).not.toBeVisible();
  await expect(page.getByTestId("sidebar-project-private-demo")).toBeVisible();
  const linked = await page.evaluate(() =>
    window.__BUZZ_E2E_ACCEPTED_PROJECT_EVENTS__?.find(
      (event) =>
        event.kind === 30617 &&
        event.tags.some((tag) => tag[0] === "d" && tag[1] === "private-demo"),
    ),
  );
  expect(linked?.tags).toContainEqual([
    "clone",
    "https://github.com/Snap-Fusion-GmbH/private-demo.git",
  ]);
  expect(linked?.tags).toContainEqual(["default-branch", "main"]);
  await page.getByTestId("project-home-context-repo-private-demo").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_GITHUB__?.calls?.some(
          (call) => call.command === "get_github_repository_state",
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("tab", { name: "Commits", exact: true }).click();
  await expect(
    page.getByText("Fixture GitHub commit", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(
    page.getByText("README.md", { exact: true }).first(),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/private-github/02-linked-project-desktop.png",
  });
  const actions = page.getByTestId("project-context-repository-actions");
  await actions.getByRole("button", { name: "Clone", exact: true }).click();
  await expect(
    actions.getByRole("button", { name: "Clone", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const status = window.__BUZZ_E2E_PROJECT_REPO_SYNC_STATUS__;
    if (!status) throw new Error("The clone did not create local sync state");
    status.local_head = "b".repeat(40);
    status.local_short_head = "bbbbbbb";
    status.ahead_count = 1;
    status.can_push = true;
    status.push_block_reason = null;
  });
  await actions.getByRole("button", { name: "Fetch", exact: true }).click();
  await actions.getByRole("button", { name: /^Push\b/ }).click();
  await expect(actions.getByRole("button", { name: /^Push\b/ })).toHaveCount(0);
});

test("GitHub repository listing failures stay recoverable instead of looking empty", async ({
  page,
}) => {
  await openImport(page);
  await page.evaluate(() => {
    const state = window.__BUZZ_E2E_GITHUB__;
    if (!state) throw new Error("GitHub fixture is missing");
    state.listError = "GitHub is unavailable.";
  });
  await page.getByTestId("github-connect").click();
  await expect(page.getByRole("alert")).toContainText("GitHub is unavailable.");
  await expect(
    page.getByText("No repositories available.", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const state = window.__BUZZ_E2E_GITHUB__;
    if (!state) throw new Error("GitHub fixture is missing");
    delete state.listError;
  });
  await page
    .getByRole("button", { name: "Refresh GitHub repositories", exact: true })
    .click();
  await page.getByTestId("github-import-repository").selectOption("6001");
  await expect(page.getByTestId("github-import-name")).toHaveValue(
    "private-demo",
  );
  await expect(page.getByTestId("github-import-submit")).toBeDisabled();
});
