import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const NEW_MEMBER = TEST_IDENTITIES.bob.pubkey;
const DISPLAY_NAME = "New Teammate";
const CONTENT = "Profile refresh fixture";

test("a missing DM profile refreshes the sidebar, header and existing message without reloading", async ({
  page,
}) => {
  await page.clock.install();
  await page.addInitScript(
    ({ member, displayName }) => {
      const state = window as Window & {
        __profilePublished?: boolean;
      };
      state.__profilePublished = false;
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
                const result = await original(command, args, options);
                if (command === "get_users_batch") {
                  const response = result as {
                    profiles: Record<string, Record<string, unknown>>;
                    missing: string[];
                  };
                  if ((args?.pubkeys as string[])?.includes(member)) {
                    if (state.__profilePublished) {
                      response.profiles[member] = {
                        ...response.profiles[member],
                        display_name: displayName,
                        avatar_url: null,
                        owner_pubkey: null,
                        nip05_handle: null,
                      };
                      response.missing = response.missing.filter(
                        (pubkey) => pubkey !== member,
                      );
                    } else {
                      delete response.profiles[member];
                      response.missing = [
                        ...new Set([...response.missing, member]),
                      ];
                    }
                  }
                }
                if (command === "get_channels") {
                  const response = structuredClone(result) as {
                    channels: Array<{
                      name: string;
                      participant_pubkeys: string[];
                      participants: string[];
                    }> | null;
                  };
                  for (const channel of response.channels ?? []) {
                    if (channel.name === "bob-tyler") channel.name = "dm";
                    channel.participants = channel.participant_pubkeys.map(
                      (pubkey, index) =>
                        pubkey === member
                          ? member
                          : (channel.participants[index] ?? pubkey),
                    );
                  }
                  return response;
                }
                return result;
              };
            },
          });
          if (typeof existing === "function") value.invoke = existing;
        },
      });
    },
    { member: NEW_MEMBER, displayName: DISPLAY_NAME },
  );
  await installMockBridge(page);
  await page.goto("/");
  const sidebar = page.getByTestId("channel-dm");
  await expect(sidebar).toBeVisible();
  await sidebar.click();
  await expect(page.getByTestId("chat-title")).toContainText(NEW_MEMBER);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: "bob-tyler",
          }) ?? false,
      ),
    )
    .toBe(true);
  const message = await page.evaluate(
    ({ pubkey, content }) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "bob-tyler",
        pubkey,
        content,
      }),
    { pubkey: NEW_MEMBER, content: CONTENT },
  );
  if (!message) throw new Error("The fixture message was not emitted");
  const row = page.getByTestId("message-row").filter({ hasText: CONTENT });
  await expect(row).toBeVisible();
  await expect(sidebar).toContainText(NEW_MEMBER);
  await expect(row.getByTestId("message-author")).not.toHaveText(DISPLAY_NAME);
  const composer = page.getByTestId("message-input");
  await composer.fill("Unsent profile-refresh draft");
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/profile-name-before.png" });
  await page.evaluate(() => {
    (window as Window & { __profilePublished?: boolean }).__profilePublished =
      true;
  });
  await page.clock.fastForward(16_000);
  await expect(sidebar).toContainText(DISPLAY_NAME);
  await expect(page.getByTestId("chat-title")).toContainText(DISPLAY_NAME);
  await expect(row.getByTestId("message-author")).toHaveText(DISPLAY_NAME);
  await expect(composer).toHaveText("Unsent profile-refresh draft");
  await expect(composer).toBeFocused();
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/profile-name-after.png" });
});
