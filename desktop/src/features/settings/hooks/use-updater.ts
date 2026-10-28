import { useState, useRef, useCallback, useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isAutoUpdateSupported } from "@/shared/api/tauri";
import updaterPolicy from "@/shared/config/updater-policy.json";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "unavailable" }
  | { state: "available"; version: string }
  | { state: "downloading" }
  | { state: "installing" }
  | { state: "ready" }
  | { state: "error"; message: string }
  | {
      state: "manual-required";
      version: string;
      /** Download location for the running distribution's update. */
      releaseUrl: string;
    };

const BACKGROUND_UPDATE_CHECK_INTERVAL_MS =
  updaterPolicy.background_check_interval_ms;
const BACKGROUND_BLOCKED_STATES = new Set<UpdateStatus["state"]>([
  "checking",
  "available",
  "downloading",
  "installing",
  "ready",
  "manual-required",
]);

const GITHUB_RELEASES_URL = "https://github.com/block/buzz/releases/latest";

function manualDownloadUrl(update: Update): string {
  const platforms = update.rawJson?.platforms;
  if (platforms && typeof platforms === "object") {
    const platform = (platforms as Record<string, unknown>)[
      updaterPolicy.linux_debian_target
    ];
    if (platform && typeof platform === "object" && "url" in platform) {
      try {
        const url = new URL(String(platform.url));
        if (url.protocol === "https:" && !url.username && !url.password) {
          return url.href;
        }
      } catch {
        return GITHUB_RELEASES_URL;
      }
    }
  }
  return GITHUB_RELEASES_URL;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUpdaterUnavailable(message: string): boolean {
  return (
    message.includes("plugin updater not found") ||
    message.includes("not initialized")
  );
}

function canRunBackgroundCheck(status: UpdateStatus): boolean {
  return !BACKGROUND_BLOCKED_STATES.has(status.state);
}

function initialUpdateStatus(): UpdateStatus {
  return { state: "idle" };
}

export function useUpdater() {
  const [status, setStatusState] = useState<UpdateStatus>(initialUpdateStatus);
  const statusRef = useRef<UpdateStatus>(initialUpdateStatus());
  const updateRef = useRef<Update | null>(null);
  const checkInFlightRef = useRef(false);
  const downloadInFlightRef = useRef(false);
  const installInFlightRef = useRef(false);
  const manualResultRequestedRef = useRef(false);

  const setStatus = useCallback((nextStatus: UpdateStatus) => {
    statusRef.current = nextStatus;
    setStatusState(nextStatus);
  }, []);

  const closeUpdate = useCallback(async () => {
    if (downloadInFlightRef.current || installInFlightRef.current) {
      return;
    }
    const current = updateRef.current;
    if (current) {
      updateRef.current = null;
      await current.close();
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    if (downloadInFlightRef.current) {
      return;
    }

    downloadInFlightRef.current = true;
    try {
      const update = updateRef.current;
      if (!update) {
        return;
      }

      setStatus({ state: "downloading" });
      await update.download();
      setStatus({ state: "ready" });
    } catch (err) {
      setStatus({ state: "error", message: toErrorMessage(err) });
    } finally {
      downloadInFlightRef.current = false;
    }
  }, [setStatus]);

  const installAndRelaunch = useCallback(async () => {
    if (installInFlightRef.current) {
      return;
    }

    const update = updateRef.current;
    if (!update) {
      return;
    }

    installInFlightRef.current = true;
    try {
      setStatus({ state: "installing" });
      await update.install();
      updateRef.current = null;
      await relaunch();
    } catch (err) {
      setStatus({ state: "error", message: toErrorMessage(err) });
    } finally {
      installInFlightRef.current = false;
    }
  }, [setStatus]);

  const runUpdateCheck = useCallback(
    async ({ background }: { background: boolean }) => {
      if (checkInFlightRef.current) {
        if (!background) {
          manualResultRequestedRef.current = true;
          setStatus({ state: "checking" });
        }
        return;
      }

      if (background && !canRunBackgroundCheck(statusRef.current)) {
        return;
      }

      checkInFlightRef.current = true;
      manualResultRequestedRef.current = false;

      try {
        await closeUpdate();

        if (!background) {
          setStatus({ state: "checking" });
        }

        const update = await check({
          headers: { "Cache-Control": "no-cache" },
        });
        const shouldShowQuietResult =
          !background || manualResultRequestedRef.current;

        if (update) {
          const autoUpdateOk = await isAutoUpdateSupported();
          updateRef.current = update;
          if (autoUpdateOk) {
            setStatus({ state: "available", version: update.version });
            void downloadUpdate();
          } else {
            updateRef.current = null;
            await update.close();
            setStatus({
              state: "manual-required",
              version: update.version,
              releaseUrl: manualDownloadUrl(update),
            });
          }
        } else if (shouldShowQuietResult) {
          setStatus({ state: "up-to-date" });
        }
      } catch (err) {
        const message = toErrorMessage(err);
        const shouldShowQuietResult =
          !background || manualResultRequestedRef.current;

        if (isUpdaterUnavailable(message)) {
          // Surface which branch fired on Windows builds where the updater
          // plugin is missing — distinguishes plugin-unavailable from a genuine
          // up-to-date result in Will's app log.
          console.warn(`updater unavailable: ${message}`);
          if (shouldShowQuietResult) {
            setStatus({ state: "unavailable" });
          }
          return;
        }

        if (shouldShowQuietResult) {
          setStatus({ state: "error", message });
        }
      } finally {
        manualResultRequestedRef.current = false;
        checkInFlightRef.current = false;
      }
    },
    [closeUpdate, downloadUpdate, setStatus],
  );

  const checkForUpdate = useCallback(async () => {
    await runUpdateCheck({ background: false });
  }, [runUpdateCheck]);

  const checkForUpdateInBackground = useCallback(async () => {
    await runUpdateCheck({ background: true });
  }, [runUpdateCheck]);

  useEffect(() => {
    void checkForUpdateInBackground();

    const intervalId = window.setInterval(() => {
      void checkForUpdateInBackground();
    }, BACKGROUND_UPDATE_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      closeUpdate();
    };
  }, [checkForUpdateInBackground, closeUpdate]);

  return {
    status,
    checkForUpdate,
    installAndRelaunch,
  };
}
