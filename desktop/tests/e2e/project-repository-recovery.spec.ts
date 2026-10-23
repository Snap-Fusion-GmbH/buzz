import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const OWNER = TEST_IDENTITIES.tyler.pubkey;

test("a relay repository without clone tags loads after a delayed origin and Fetch keeps its empty state", async ({
  page,
}) => {
  await page.addInitScript((owner) => {
    const state = window as Window & {
      __repositoryOriginCalls?: number;
      __releaseRepositoryOrigin?: () => void;
      __repositorySnapshotUrls?: string[];
    };
    state.__repositoryOriginCalls = 0;
    state.__repositorySnapshotUrls = [];
    const originReady = new Promise<void>((resolve) => {
      state.__releaseRepositoryOrigin = resolve;
    });
    const channel = "cf63feec-21bb-5bf0-a2f8-0e4c3de8ec73";
    window.__BUZZ_E2E_EXTRA_PROJECT_EVENTS__ = [30617, 30621].map(
      (kind, index) => ({
        id: String(index + 1).repeat(64),
        kind,
        pubkey: owner,
        created_at: Math.floor(Date.now() / 1_000),
        content: "",
        tags: [
          ["d", "empty-repo"],
          ["name", "Empty repository fixture"],
          ["buzz-channel", channel],
          ...(kind === 30621 ? [["a", `30617:${owner}:empty-repo`]] : []),
        ],
      }),
    );
    type Invoke = (
      command: string,
      args?: Record<string, unknown>,
      options?: unknown,
    ) => Promise<unknown>;
    let internals: Record<string, unknown>;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => internals,
      set(value) {
        internals = value;
        const existing = value.invoke;
        let invoke: Invoke;
        Object.defineProperty(value, "invoke", {
          configurable: true,
          get: () => invoke,
          set(original: Invoke) {
            invoke = async (command, args, options) => {
              if (command === "get_relay_http_url") {
                state.__repositoryOriginCalls =
                  (state.__repositoryOriginCalls ?? 0) + 1;
                await originReady;
              }
              if (
                command === "get_project_repo_snapshot" &&
                String(args?.cloneUrl).endsWith("/empty-repo")
              ) {
                state.__repositorySnapshotUrls?.push(String(args?.cloneUrl));
                return {
                  latest_commit: null,
                  commits: [],
                  files: [],
                  contributors: [],
                };
              }
              return original(command, args, options);
            };
          },
        });
        if (typeof existing === "function") value.invoke = existing;
      },
    });
  }, OWNER);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-projects-view").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __repositoryOriginCalls?: number })
            .__repositoryOriginCalls ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect(page.getByText("Repository not initialized")).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as Window & { __releaseRepositoryOrigin?: () => void }
    ).__releaseRepositoryOrigin?.(),
  );
  await page.getByTestId("projects-section-projects").click();
  await page
    .locator(
      '[data-testid="project-card-empty-repo"], [data-testid="project-row-empty-repo"]',
    )
    .first()
    .click();
  await page.getByTestId("project-home-context-repo-empty-repo").click();
  await expect(page.getByText("No files have been pushed yet")).toBeVisible();
  await expect(page.getByTestId("project-repository-unavailable")).toHaveCount(
    0,
  );
  const snapshotUrls = () =>
    page.evaluate(
      () =>
        (window as Window & { __repositorySnapshotUrls?: string[] })
          .__repositorySnapshotUrls ?? [],
    );
  await expect
    .poll(async () => [...new Set(await snapshotUrls())])
    .toEqual([`http://localhost:3000/git/${OWNER}/empty-repo`]);
  const requestsBeforeFetch = (await snapshotUrls()).length;
  await page
    .getByRole("button", { name: "Fetch", exact: true })
    .first()
    .click();
  await expect
    .poll(async () => (await snapshotUrls()).length)
    .toBeGreaterThan(requestsBeforeFetch);
  await expect(page.getByText("Remote state refreshed.")).toBeVisible();
  await expect(page.getByText("No files have been pushed yet")).toBeVisible();
  await expect(
    page.getByText("Repository unavailable", { exact: true }),
  ).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/project-repository-recovered.png",
  });
});
