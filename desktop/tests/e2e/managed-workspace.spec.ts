import { expect, test } from "@playwright/test";
import type { ManagedWorkspaceStatus } from "../../src/shared/api/tauriManagedWorkspace";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const publicKey = "deadbeef".repeat(8);

const signedOut: ManagedWorkspaceStatus = {
  enabled: true,
  signed_in: false,
  workspace_id: "fixture-rd",
  public_key: publicKey,
  profile: null,
};

function signedIn(): ManagedWorkspaceStatus {
  return {
    ...signedOut,
    signed_in: true,
    profile: {
      workspace_name: "Snap Fusion",
      display_name: "Fixture member",
      role: "member",
      relay_url: "wss://managed.example.invalid",
      channels: [],
      credentials_included: false,
      teams_message_sync: false,
    },
  };
}

test("managed build starts at work-account sign-in without technical setup", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { managedWorkspace: { status: signedOut } },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await expect(page.getByTestId("managed-workspace-gate")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Microsoft" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/managed-workspace-sign-in.png" });
});

test("failed membership never falls through to an unconfigured community", async ({
  page,
}) => {
  await installMockBridge(
    page,
    {
      managedWorkspace: {
        status: signedOut,
        loginError: "Current R&D membership required",
      },
    },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Current R&D membership required",
  );
  await expect(page.getByTestId("managed-workspace-gate")).toBeVisible();
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Sign in with Microsoft" }),
  ).toBeVisible();
});

test("verified enrollment seeds the workspace and completes machine setup", async ({
  page,
}) => {
  await installMockBridge(
    page,
    { managedWorkspace: { status: signedOut, loginResult: signedIn() } },
    {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
      relayWsUrl: "wss://managed.example.invalid",
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
  await expect(page.getByTestId("managed-workspace-gate")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          localStorage.getItem(`buzz-machine-onboarding-complete.v2:${key}`),
        publicKey,
      ),
    )
    .toBe("true");
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
});

test("verification outage stays blocked and offers a retry", async ({
  page,
}) => {
  await installMockBridge(
    page,
    {
      managedWorkspace: {
        status: signedOut,
        statusError: "fixture directory outage",
      },
    },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "Workspace verification is temporarily unavailable.",
  );
  await expect(
    page.getByRole("button", { name: "Retry verification" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Microsoft" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/managed-workspace-verification-unavailable.png",
  });
});

test("an existing session recovers from outages and denied access without another login", async ({
  page,
}) => {
  await page.clock.install();
  await installMockBridge(
    page,
    { managedWorkspace: { status: signedIn(), loginResult: signedIn() } },
    {
      skipCommunitySeed: true,
      skipOnboardingSeed: true,
      relayWsUrl: "wss://managed.example.invalid",
    },
  );
  await page.goto("/");
  await expect(page.getByTestId("app-sidebar")).toBeVisible();
  await page.clock.fastForward(5 * 60_000);
  await expect(page.getByTestId("managed-workspace-gate")).toHaveCount(0);

  for (const reason of [
    "managed_workspace_unavailable",
    "managed_workspace_access_denied",
  ]) {
    await page.evaluate((message) => {
      const managed = window.__BUZZ_E2E__?.mock?.managedWorkspace;
      if (!managed) throw new Error("Managed workspace fixture is missing");
      managed.statusError = message;
    }, reason);
    await page.clock.fastForward(15_000);
    await expect(page.getByTestId("managed-workspace-gate")).toBeVisible();
    await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Sign in with Microsoft" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Retry verification" }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      reason === "managed_workspace_access_denied"
        ? "Workspace access is not currently authorized."
        : "Workspace verification is temporarily unavailable.",
    );
    await page.evaluate(() => {
      const managed = window.__BUZZ_E2E__?.mock?.managedWorkspace;
      if (!managed) throw new Error("Managed workspace fixture is missing");
      delete managed.statusError;
    });
    await page.clock.fastForward(15_000);
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    await expect(page.getByTestId("managed-workspace-gate")).toHaveCount(0);
  }

  expect(
    await page.evaluate(
      () =>
        window.__BUZZ_E2E_COMMANDS__?.filter(
          (command) => command === "managed_workspace_login",
        ).length ?? 0,
    ),
  ).toBe(0);
  let logins = 0;
  for (const [reason, message] of [
    [
      "managed_workspace_sign_in_required",
      "Your Microsoft session needs you to sign in again.",
    ],
    [
      "managed_workspace_session_recovery_required",
      "The saved Microsoft session could not be read. Sign in again to replace it; your Buzz identity is unchanged.",
    ],
  ]) {
    await page.evaluate((failure) => {
      const managed = window.__BUZZ_E2E__?.mock?.managedWorkspace;
      if (!managed) throw new Error("Managed workspace fixture is missing");
      managed.statusError = failure;
    }, reason);
    await page.clock.fastForward(15_000);
    await expect(page.getByRole("alert")).toHaveText(message);
    await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
    await page.evaluate(() => {
      const managed = window.__BUZZ_E2E__?.mock?.managedWorkspace;
      if (!managed) throw new Error("Managed workspace fixture is missing");
      delete managed.statusError;
    });
    await page.getByRole("button", { name: "Sign in with Microsoft" }).click();
    await expect(page.getByTestId("app-sidebar")).toBeVisible();
    logins += 1;
    expect(
      await page.evaluate(
        () =>
          window.__BUZZ_E2E_COMMANDS__?.filter(
            (command) => command === "managed_workspace_login",
          ).length ?? 0,
      ),
    ).toBe(logins);
  }
});

test("locked system identity uses recovery without offering a replacement identity", async ({
  page,
}) => {
  await installMockBridge(
    page,
    {
      managedWorkspace: {
        status: signedOut,
        statusError: "managed_workspace_identity_locked",
      },
    },
    { skipCommunitySeed: true, skipOnboardingSeed: true },
  );
  await page.goto("/");
  await expect(page.getByTestId("keyring-locked")).toBeVisible();
  await expect(page.getByTestId("relaunch-app")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sign in with Microsoft" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create a new identity key" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("app-sidebar")).toHaveCount(0);
});
