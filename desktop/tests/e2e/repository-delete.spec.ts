import { expect, type Page, test } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

type AcceptedEvent = { kind: number; tags: string[][] };

function acceptedDeletions(page: Page) {
  return page.evaluate(() =>
    (
      (
        window as Window & {
          __BUZZ_E2E_ACCEPTED_PROJECT_EVENTS__?: AcceptedEvent[];
        }
      ).__BUZZ_E2E_ACCEPTED_PROJECT_EVENTS__ ?? []
    )
      .filter((event) => event.kind === 5)
      .map((event) => event.tags),
  );
}

async function openRepositories(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-projects-view").click();
  await expect(page.getByTestId("projects-page-tabs")).toBeVisible();
  await page.getByTestId("projects-section-repositories").click();
}

test("an owned standalone repository can be deleted from the Repositories list", async ({
  page,
}) => {
  // No project claims the repositories, so each is listed on its own.
  await page.addInitScript(() => {
    window.__BUZZ_E2E_REPOSITORY_ONLY_PROJECTS__ = true;
  });
  await installMockBridge(page);
  await openRepositories(page);

  const row = page.locator(
    '[data-testid="repository-card-buzz"], [data-testid="repository-row-buzz"]',
  );
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "More options for buzz" }).click();
  await page.getByTestId("repository-delete-buzz").click();

  const confirm = page.getByTestId("repository-delete-confirm-buzz");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("Delete repository?");
  // Cancelling publishes nothing.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  expect(await acceptedDeletions(page)).toEqual([]);

  await row.getByRole("button", { name: "More options for buzz" }).click();
  await page.getByTestId("repository-delete-buzz").click();
  await page.getByTestId("repository-delete-confirm-button-buzz").click();

  await expect(page.getByText("Repository deleted")).toBeVisible();
  const deletions = await acceptedDeletions(page);
  expect(deletions).toHaveLength(1);
  expect(deletions[0]).toContainEqual([
    "a",
    expect.stringMatching(/^30617:[0-9a-f]{64}:buzz$/),
  ]);
  await expect(row).toHaveCount(0);
});

test("a repository owned by someone else offers no delete action", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__BUZZ_E2E_REPOSITORY_ONLY_PROJECTS__ = true;
    window.__BUZZ_E2E_PROJECT_OWNER_OVERRIDE__ = "b".repeat(64);
  });
  await installMockBridge(page);
  await openRepositories(page);

  const row = page.locator(
    '[data-testid="repository-card-buzz"], [data-testid="repository-row-buzz"]',
  );
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "More options for buzz" }).click();
  await expect(page.getByRole("menuitem", { name: "Copy link" })).toBeVisible();
  await expect(page.getByTestId("repository-delete-buzz")).toHaveCount(0);
});
