import { expect, test, type Page } from "@playwright/test";
import type {
  ChannelMeeting,
  MeetingScope,
} from "../../src/shared/api/meetingTypes";
import { installMockBridge } from "../helpers/bridge";
import { invokeMockCommand } from "../helpers/mockCommands";
import { waitForAnimations } from "../helpers/animations";

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-26T07:44:30Z") });
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(
    page.getByRole("tab", { name: "Messages", exact: true }),
  ).toBeVisible();
});

async function createTimedMeeting(page: Page, recurrence = "once") {
  await page.getByRole("tab", { name: "Meetings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "New meeting", exact: true }),
  ).toBeEnabled();
  const scope = await page.evaluate(() => {
    const log = (
      window as Window & {
        __BUZZ_E2E_COMMAND_LOG__?: Array<{
          command: string;
          payload: { scope: MeetingScope };
        }>;
      }
    ).__BUZZ_E2E_COMMAND_LOG__;
    return log?.findLast((entry) => entry.command === "get_channel_meetings")
      ?.payload.scope;
  });
  expect(scope).toBeTruthy();
  await invokeMockCommand(page, "save_channel_meeting", {
    scope,
    meetingId: "56686c1e-5f4e-42d4-9e45-a4e31a45719a",
    expectedRevision: null,
    definition: {
      version: 1,
      title: "Team sync",
      starts_at: "2026-10-26T08:50:00",
      timezone: "Europe/Berlin",
      duration_minutes: 30,
      recurrence,
      status: "active",
      skipped_dates: [],
    },
  });
  await page
    .getByRole("button", { name: "Refresh meetings", exact: true })
    .click();
  const row = page.getByRole("article", { name: "Team sync", exact: true });
  await expect(row).toBeVisible();
  return { row, scope: scope as MeetingScope };
}

async function assertSelectedTab(page: Page, name: string) {
  const selected = page.getByRole("tab", { name, exact: true });
  await expect(selected).toHaveAttribute("aria-selected", "true");
  const styles = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    const sibling = [
      ...(element.parentElement?.querySelectorAll('[role="tab"]') ?? []),
    ].find((tab) => tab !== element);
    if (!sibling) throw new Error("Other channel tab missing");
    return {
      border: style.borderBottomColor,
      siblingBorder: getComputedStyle(sibling).borderBottomColor,
      fill: style.backgroundColor,
      siblingFill: getComputedStyle(sibling).backgroundColor,
    };
  });
  expect(styles.border).not.toBe(styles.siblingBorder);
  expect(styles.fill).not.toBe(styles.siblingFill);
}

test("channel tabs have a visible selected state and meetings align to both edges", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.classList.toggle("dark", value === "dark");
    }, theme);
    await assertSelectedTab(page, "Messages");
    await page.getByRole("tab", { name: "Meetings", exact: true }).click();
    await assertSelectedTab(page, "Meetings");
    for (const width of [1800, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      const gutters = await page
        .getByTestId("channel-meetings")
        .evaluate((section) => {
          const outer = section.getBoundingClientRect();
          const content = section.firstElementChild?.getBoundingClientRect();
          if (!content) throw new Error("Meeting content missing");
          return {
            left: content.left - outer.left,
            right: outer.right - content.right,
          };
        });
      expect(gutters.left).toBeCloseTo(20, 0);
      expect(gutters.right).toBeCloseTo(20, 0);
    }
    await page.getByRole("tab", { name: "Messages", exact: true }).click();
  }
});

test("scheduled time drives upcoming, in-progress and ended states without starting audio", async ({
  page,
}) => {
  const { row } = await createTimedMeeting(page);
  await expect(row.getByTestId("meeting-status")).toHaveText("Upcoming");
  await expect(row.getByTestId("meeting-time-range")).toContainText("08:50");
  await expect(row.getByTestId("meeting-time-range")).toContainText("09:20");
  await expect(row.getByTestId("meeting-time-range")).not.toContainText(
    /AM|PM/,
  );
  await page.clock.runFor(5 * 60_000 + 30_000);
  await expect(row.getByTestId("meeting-status")).toHaveText("In progress");
  await expect(row).toContainText("30 min left");
  await expect(
    row.getByRole("button", { name: "Skip next", exact: true }),
  ).toHaveCount(0);
  await page.clock.runFor(60_000);
  await expect(row).toContainText("29 min left");
  await waitForAnimations(page);
  await page
    .getByTestId("channel-meetings")
    .screenshot({ path: "test-results/channel-meetings-in-progress.png" });
  await page.clock.runFor(29 * 60_000);
  await expect(row.getByTestId("meeting-status")).toHaveText("Ended");
  await expect(
    row.getByRole("button", { name: "Edit series", exact: true }),
  ).toBeEnabled();
  const audioCommands = await page.evaluate(() => {
    const log =
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{ command: string }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__ ?? [];
    return log.filter((entry) =>
      ["start_huddle", "join_huddle"].includes(entry.command),
    );
  });
  expect(audioCommands).toEqual([]);
});

test("Messages nudges start five minutes before, roll forward and respect skip/cancel", async ({
  page,
}) => {
  const { row } = await createTimedMeeting(page, "weekly");
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  const banner = page.getByTestId("channel-meeting-nudge");
  await expect(banner).toHaveCount(0);
  await page.clock.runFor(30_000);
  await expect(banner).toContainText("Starts in 5 min");
  await page.clock.runFor(6 * 60_000);
  await expect(banner).toContainText("Scheduled now · 29 min left");
  await expect(
    banner.getByRole("button", { name: "Start huddle", exact: true }),
  ).toBeEnabled();
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/channel-meeting-nudge.png" });
  await banner
    .getByRole("button", { name: "View meetings", exact: true })
    .click();
  await assertSelectedTab(page, "Meetings");
  await expect(row.getByTestId("meeting-status")).toHaveText("In progress");
  await page.clock.runFor(29 * 60_000);
  await expect(row.getByTestId("meeting-status")).toHaveText("Upcoming");
  await expect(row.getByTestId("meeting-time-range")).toContainText("Nov");
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(banner).toHaveCount(0);
  await page.getByTestId("channel-random").click();
  await expect(banner).toHaveCount(0);
  await page.getByTestId("channel-general").click();
  await page.getByRole("tab", { name: "Meetings", exact: true }).click();
  await row.getByRole("button", { name: "Skip next", exact: true }).click();
  await page
    .getByRole("button", { name: "Skip occurrence", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await row.getByRole("button", { name: "Cancel series", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel series", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(banner).toHaveCount(0);
});

test("meeting huddle action uses the channel and keeps failures visible and retryable", async ({
  page,
}) => {
  const { scope } = await createTimedMeeting(page);
  await page.evaluate(() => {
    const target = window as typeof window & {
      __TAURI_INTERNALS__: {
        invoke: (command: string, payload: unknown) => Promise<unknown>;
      };
      huddleAttempts?: unknown[];
    };
    const original = target.__TAURI_INTERNALS__.invoke.bind(
      target.__TAURI_INTERNALS__,
    );
    target.huddleAttempts = [];
    target.__TAURI_INTERNALS__.invoke = async (command, payload) => {
      if (command === "start_huddle" || command === "join_huddle") {
        target.huddleAttempts?.push({ command, payload });
        throw new Error("huddle_audio_unavailable");
      }
      return original(command, payload);
    };
  });
  const action = page
    .getByTestId("channel-meetings")
    .getByTestId("meeting-huddle-action");
  await action
    .getByRole("button", { name: "Start huddle", exact: true })
    .click();
  await expect(action.getByRole("alert")).toContainText(
    "Huddle audio isn’t available on this server",
  );
  const attempts = () =>
    page.evaluate(
      () => (window as Window & { huddleAttempts?: unknown[] }).huddleAttempts,
    );
  expect(await attempts()).toEqual([
    {
      command: "start_huddle",
      payload: {
        parentChannelId: scope.channelId,
        memberPubkeys: [],
        channelName: "general huddle",
      },
    },
  ]);
  await action
    .getByRole("button", { name: "Start huddle", exact: true })
    .click();
  await expect.poll(attempts).toHaveLength(2);
  const ephemeral = "96086189-1024-45bd-a9bf-c9728b1e313c";
  await page.evaluate((ephemeralChannelId) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      kind: 48100,
      content: JSON.stringify({ ephemeral_channel_id: ephemeralChannelId }),
    });
  }, ephemeral);
  await expect(
    action.getByRole("button", { name: "Join huddle", exact: true }),
  ).toBeVisible();
  await action
    .getByRole("button", { name: "Join huddle", exact: true })
    .click();
  await expect.poll(attempts).toHaveLength(3);
  expect((await attempts())?.[2]).toMatchObject({
    command: "join_huddle",
    payload: {
      parentChannelId: scope.channelId,
      ephemeralChannelId: ephemeral,
    },
  });
});

test("skip and cancel remove a reminder that would otherwise still be due", async ({
  page,
}) => {
  const { row, scope } = await createTimedMeeting(page, "weekly");
  await page.clock.runFor(30_000);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  const banner = page.getByTestId("channel-meeting-nudge");
  await expect(banner).toBeVisible();
  await banner
    .getByRole("button", { name: "View meetings", exact: true })
    .click();
  await row.getByRole("button", { name: "Skip next", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Skip occurrence", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(banner).toHaveCount(0);
  const [meeting] = await invokeMockCommand<ChannelMeeting[]>(
    page,
    "get_channel_meetings",
    { scope },
  );
  await invokeMockCommand(page, "save_channel_meeting", {
    scope,
    meetingId: meeting.id,
    expectedRevision: meeting.revision,
    definition: { ...meeting.definition, skipped_dates: [] },
  });
  await page.getByRole("tab", { name: "Meetings", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh meetings", exact: true })
    .click();
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(banner).toBeVisible();
  await banner
    .getByRole("button", { name: "View meetings", exact: true })
    .click();
  await row.getByRole("button", { name: "Cancel series", exact: true }).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Cancel series", exact: true })
    .click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(banner).toHaveCount(0);
});
