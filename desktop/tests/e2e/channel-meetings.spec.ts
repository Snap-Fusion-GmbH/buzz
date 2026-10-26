import { expect, test, type Page } from "@playwright/test";
import type {
  ChannelMeeting,
  MeetingScope,
} from "../../src/shared/api/meetingTypes";
import { installMockBridge } from "../helpers/bridge";
import { invokeMockCommand } from "../helpers/mockCommands";
import { waitForAnimations } from "../helpers/animations";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("channel-general").click();
});

async function openMeetings(page: Page) {
  await page.getByRole("tab", { name: "Meetings", exact: true }).click();
  await expect(page.getByTestId("channel-meetings")).toBeVisible();
}

async function fillMeeting(page: Page, title: string) {
  await page.getByRole("button", { name: "New meeting", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New meeting", exact: true });
  await dialog.getByLabel("Meeting name", { exact: true }).fill(title);
  await dialog.getByLabel("First meeting", { exact: true }).fill("2099-10-26");
  await dialog.getByLabel("Start time", { exact: true }).fill("10:00");
  await dialog
    .getByLabel("Meeting timezone", { exact: true })
    .fill("Europe/Berlin");
  await expect(
    dialog.getByRole("button", { name: "Create meeting", exact: true }),
  ).toBeEnabled();
  return dialog;
}

async function createMeeting(page: Page, title: string) {
  const dialog = await fillMeeting(page, title);
  await dialog
    .getByRole("button", { name: "Create meeting", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  return page.getByRole("article", { name: title, exact: true });
}

test("unsupported relays cannot be mistaken for empty meeting calendars and can recover", async ({
  page,
}) => {
  await page.evaluate(() => {
    (
      window as Window & { __BUZZ_E2E_MEETINGS_SUPPORTED__?: boolean }
    ).__BUZZ_E2E_MEETINGS_SUPPORTED__ = false;
  });
  await openMeetings(page);
  await expect(
    page.getByRole("heading", { name: "Relay update required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New meeting", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("heading", { name: "No meetings yet", exact: true }),
  ).toHaveCount(0);
  const reads = await page.evaluate(
    () =>
      (
        window as Window & {
          __BUZZ_E2E_COMMAND_LOG__?: Array<{ command: string }>;
        }
      ).__BUZZ_E2E_COMMAND_LOG__?.filter(
        (entry) => entry.command === "get_channel_meetings",
      ).length ?? 0,
  );
  expect(reads).toBe(0);
  await page.evaluate(() => {
    (
      window as Window & { __BUZZ_E2E_MEETINGS_SUPPORTED__?: boolean }
    ).__BUZZ_E2E_MEETINGS_SUPPORTED__ = true;
  });
  await page
    .getByRole("button", { name: "Refresh meetings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New meeting", exact: true }),
  ).toBeEnabled();
  await expect(
    await createMeeting(page, "Created after a relay upgrade"),
  ).toBeVisible();
});

test("relay version errors keep the draft and do not expose the IPC error wrapper", async ({
  page,
}) => {
  await openMeetings(page);
  const editor = await fillMeeting(page, "Keep this unsaved meeting");
  await page.evaluate(() => {
    (
      window as Window & { __BUZZ_E2E_MEETINGS_SUPPORTED__?: boolean }
    ).__BUZZ_E2E_MEETINGS_SUPPORTED__ = false;
  });
  await editor
    .getByRole("button", { name: "Create meeting", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText(
    "relay needs an update",
  );
  await expect(editor.getByRole("alert")).not.toContainText("TauriInvokeError");
  await expect(editor.getByLabel("Meeting name", { exact: true })).toHaveValue(
    "Keep this unsaved meeting",
  );
  await page.evaluate(() => {
    (
      window as Window & { __BUZZ_E2E_MEETINGS_SUPPORTED__?: boolean }
    ).__BUZZ_E2E_MEETINGS_SUPPORTED__ = true;
  });
  await editor
    .getByRole("button", { name: "Create meeting", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  await expect(
    page.getByRole("article", {
      name: "Keep this unsaved meeting",
      exact: true,
    }),
  ).toBeVisible();
});

test("keyboard-accessible channel meetings create, edit, skip, and cancel a series", async ({
  page,
}) => {
  const messages = page.getByRole("tab", { name: "Messages", exact: true });
  await messages.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Meetings", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("channel-meetings")).toBeVisible();
  const dialog = await fillMeeting(page, "Weekly planning");
  await expect(dialog.getByLabel("Where to meet")).toHaveCount(0);
  await expect(dialog.getByLabel("Preparation note")).toHaveCount(0);
  await expect(dialog.getByLabel("Duration", { exact: true })).toHaveCSS(
    "appearance",
    "none",
  );
  await expect(dialog.getByLabel("Repeats", { exact: true })).toHaveCSS(
    "appearance",
    "none",
  );
  await expect(
    dialog
      .getByRole("region", { name: "Upcoming meeting dates" })
      .getByRole("listitem"),
  ).toHaveCount(3);
  await waitForAnimations(page);
  await dialog.screenshot({ path: "test-results/channel-meetings-editor.png" });
  await dialog
    .getByRole("button", { name: "Create meeting", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const row = page.getByRole("article", {
    name: "Weekly planning",
    exact: true,
  });
  await expect(row).toBeVisible();
  await waitForAnimations(page);
  await page
    .getByTestId("channel-meetings")
    .screenshot({ path: "test-results/channel-meetings-list.png" });
  await row.getByRole("button", { name: "Edit series", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Edit meeting series",
    exact: true,
  });
  await editor
    .getByLabel("Meeting name", { exact: true })
    .fill("Weekly priorities");
  await expect(
    editor.getByRole("button", { name: "Save series", exact: true }),
  ).toBeEnabled();
  await editor
    .getByRole("button", { name: "Save series", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  const updated = page.getByRole("article", {
    name: "Weekly priorities",
    exact: true,
  });
  await updated.getByRole("button", { name: "Skip next", exact: true }).click();
  const skip = page.getByRole("alertdialog", {
    name: "Skip this occurrence?",
    exact: true,
  });
  await skip
    .getByRole("button", { name: "Skip occurrence", exact: true })
    .click();
  await expect(skip).not.toBeVisible();
  await expect(updated.locator("p").first()).toContainText("Nov");
  await updated
    .getByRole("button", { name: "Edit series", exact: true })
    .click();
  const reschedule = page.getByRole("dialog", {
    name: "Edit meeting series",
    exact: true,
  });
  await reschedule
    .getByLabel("First meeting", { exact: true })
    .fill("2099-11-02");
  await expect(reschedule).toContainText("skipped date(s) no longer occur");
  await expect(
    reschedule.getByRole("button", { name: "Save series", exact: true }),
  ).toBeEnabled();
  const previewSkips = await page.evaluate(() => {
    const log = (
      window as Window & {
        __BUZZ_E2E_COMMAND_LOG__?: Array<{ command: string; payload: unknown }>;
      }
    ).__BUZZ_E2E_COMMAND_LOG__;
    return (
      log?.findLast((entry) => entry.command === "preview_meeting_definition")
        ?.payload as { definition: { skipped_dates: string[] } }
    ).definition.skipped_dates;
  });
  expect(previewSkips).toEqual([]);
  await reschedule
    .getByRole("button", { name: "Save series", exact: true })
    .click();
  await expect(reschedule).not.toBeVisible();
  const savedSkips = await page.evaluate(() => {
    const log = (
      window as Window & {
        __BUZZ_E2E_COMMAND_LOG__?: Array<{ command: string; payload: unknown }>;
      }
    ).__BUZZ_E2E_COMMAND_LOG__;
    return (
      log?.findLast((entry) => entry.command === "save_channel_meeting")
        ?.payload as { definition: { skipped_dates: string[] } }
    ).definition.skipped_dates;
  });
  expect(savedSkips).toEqual([]);
  await updated
    .getByRole("button", { name: "Cancel series", exact: true })
    .click();
  const cancel = page.getByRole("alertdialog", {
    name: "Cancel meeting series?",
    exact: true,
  });
  await cancel
    .getByRole("button", { name: "Cancel series", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No meetings yet", exact: true }),
  ).toBeVisible();
});

test("meetings stay channel scoped when moving between channel views", async ({
  page,
}) => {
  await openMeetings(page);
  await createMeeting(page, "General team sync");
  await page.getByTestId("channel-random").click();
  await openMeetings(page);
  await expect(
    page.getByRole("heading", { name: "No meetings yet", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "General team sync", exact: true }),
  ).toHaveCount(0);
  await page.getByTestId("channel-general").click();
  await openMeetings(page);
  await expect(
    page.getByRole("article", { name: "General team sync", exact: true }),
  ).toBeVisible();
});

test("switching meeting views preserves an unsent message draft", async ({
  page,
}) => {
  const composer = page
    .getByTestId("channel-drop-zone")
    .getByTestId("message-input");
  await composer.fill("Unsent message draft while checking meetings");
  await openMeetings(page);
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(composer).toHaveText(
    "Unsent message draft while checking meetings",
  );
});

test("opening auxiliary channel settings keeps the message timeline mounted", async ({
  page,
}) => {
  const timeline = page.getByTestId("message-timeline");
  await expect(timeline).toBeVisible();
  const original = await timeline.elementHandle();
  expect(original).not.toBeNull();
  await page.getByTestId("channel-management-trigger").click();
  await expect(page.getByTestId("channel-management-sheet")).toBeVisible();
  expect(await original?.evaluate((element) => element.isConnected)).toBe(true);
  await page.getByTestId("auxiliary-panel-close").click();
  await expect(page.getByTestId("channel-management-sheet")).not.toBeVisible();
  expect(await original?.evaluate((element) => element.isConnected)).toBe(true);
  await expect(
    page.getByRole("tab", { name: "Meetings", exact: true }),
  ).toBeVisible();
});

test("a narrow editor keeps a dismissed draft until explicitly discarded", async ({
  page,
}) => {
  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-general").click();
  await page.setViewportSize({ width: 760, height: 800 });
  await openMeetings(page);
  const editor = await fillMeeting(page, "Preserve my meeting draft");
  const warning = page.getByRole("alertdialog", {
    name: "Discard meeting changes?",
    exact: true,
  });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+[" : "Alt+ArrowLeft",
  );
  await expect(warning).toBeVisible();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await warning.getByRole("button", { name: "Keep editing" }).click();
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Keep editing" }).click();
  await expect(editor.getByLabel("Meeting name", { exact: true })).toHaveValue(
    "Preserve my meeting draft",
  );
  await expect(
    editor.getByRole("button", { name: "Create meeting", exact: true }),
  ).toBeInViewport();
  await waitForAnimations(page);
  await editor.screenshot({ path: "test-results/channel-meetings-narrow.png" });
  await page.keyboard.press("Escape");
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No meetings yet", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Messages", exact: true }).click();
  await expect(page.getByTestId("channel-drop-zone")).toBeVisible();
});

test("stale edits retain the draft and do not overwrite a newer head", async ({
  page,
}) => {
  await openMeetings(page);
  const row = await createMeeting(page, "Original meeting");
  const scope = await page.evaluate(() => {
    const log = (
      window as Window & {
        __BUZZ_E2E_COMMAND_LOG__?: Array<{ command: string; payload: unknown }>;
      }
    ).__BUZZ_E2E_COMMAND_LOG__;
    return (
      log?.findLast((entry) => entry.command === "save_channel_meeting")
        ?.payload as { scope: MeetingScope }
    ).scope;
  });
  const heads = await invokeMockCommand<ChannelMeeting[]>(
    page,
    "get_channel_meetings",
    { scope },
  );
  const original = heads[0];
  await row.getByRole("button", { name: "Edit series", exact: true }).click();
  const editor = page.getByRole("dialog", {
    name: "Edit meeting series",
    exact: true,
  });
  await editor
    .getByLabel("Meeting name", { exact: true })
    .fill("My local draft");
  await invokeMockCommand(page, "save_channel_meeting", {
    scope,
    meetingId: original.id,
    expectedRevision: original.revision,
    definition: { ...original.definition, title: "Updated on another device" },
  });
  await expect(
    editor.getByRole("button", { name: "Save series", exact: true }),
  ).toBeEnabled();
  await editor
    .getByRole("button", { name: "Save series", exact: true })
    .click();
  await expect(editor.getByRole("alert")).toContainText("conflict:");
  await expect(editor.getByLabel("Meeting name", { exact: true })).toHaveValue(
    "My local draft",
  );
  const after = await invokeMockCommand<ChannelMeeting[]>(
    page,
    "get_channel_meetings",
    { scope },
  );
  expect(after[0].definition.title).toBe("Updated on another device");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Refresh meetings", exact: true })
    .click();
  await expect(
    page.getByRole("article", {
      name: "Updated on another device",
      exact: true,
    }),
  ).toBeVisible();
});
