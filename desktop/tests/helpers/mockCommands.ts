import type { Page } from "@playwright/test";

/** Invoke the mock command boundary without seeding product query caches. */
export async function invokeMockCommand<T>(
  page: Page,
  command: string,
  payload?: Record<string, unknown>,
) {
  return page.evaluate(
    async ({ command, payload }) => {
      const bridgeWindow = window as Window & {
        __BUZZ_E2E_INVOKE_MOCK_COMMAND__?: (
          command: string,
          payload?: Record<string, unknown>,
        ) => Promise<unknown>;
        __TAURI_INTERNALS__?: {
          invoke?: (
            command: string,
            payload?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      };
      const invoke =
        bridgeWindow.__BUZZ_E2E_INVOKE_MOCK_COMMAND__ ??
        bridgeWindow.__TAURI_INTERNALS__?.invoke;

      if (!invoke) {
        throw new Error("Mock invoke bridge is unavailable.");
      }

      return (await invoke(command, payload)) as T;
    },
    { command, payload },
  );
}
