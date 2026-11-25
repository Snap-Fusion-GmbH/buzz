import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  harnessUpdatesQueryKey,
  useHarnessUpdatesQuery,
  useUpdateHarnessCliMutation,
  useUpgradeAdapterMutation,
} from "@/features/agents/hooks";
import { useInstallOutputLine } from "@/features/agents/lib/useInstallOutputLine";
import { adapterUpdateWarning } from "@/features/settings/ui/harnessCatalogLogic";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { getInstallErrorMessage } from "@/shared/lib/installError";
import { Button } from "@/shared/ui/button";

/**
 * "Update available" for an installed harness: its Buzz-managed ACP adapter
 * updates in place; its vendor CLI updates through the vendor's own updater
 * in a terminal, shown first. Renders nothing when everything is current or
 * the versions cannot be read.
 */
export function HarnessUpdateNotice({
  runtime,
}: {
  runtime: AcpRuntimeCatalogEntry;
}) {
  const queryClient = useQueryClient();
  const updatesQuery = useHarnessUpdatesQuery();
  const { mutateAsync: upgradeAdapter, isPending: upgrading } =
    useUpgradeAdapterMutation();
  const { mutateAsync: updateCli, isPending: launching } =
    useUpdateHarnessCliMutation();
  const [confirmingCli, setConfirmingCli] = React.useState(false);
  const [cliLaunched, setCliLaunched] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const outputLine = useInstallOutputLine(runtime.id, upgrading);
  const info = updatesQuery.data?.find(
    (entry) => entry.runtime_id === runtime.id,
  );

  if (
    !info ||
    runtime.availability !== "available" ||
    !(info.adapter.update_available || info.cli.update_available)
  ) {
    return null;
  }
  const label = runtime.label;

  async function runAdapterUpgrade() {
    setError(null);
    try {
      const result = await upgradeAdapter(runtime.id);
      if (!result.success) setError(getInstallErrorMessage(result));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function runCliUpdate() {
    setError(null);
    try {
      await updateCli(runtime.id);
      setConfirmingCli(false);
      setCliLaunched(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div
      className="mt-2 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs"
      data-testid={`harness-update-${runtime.id}`}
    >
      {info.adapter.update_available ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            <span className="font-medium">Adapter update available</span>{" "}
            {info.adapter.installed} → {info.adapter.latest}
            <span className="block text-muted-foreground">
              {adapterUpdateWarning(runtime)}
            </span>
          </p>
          <Button
            disabled={upgrading}
            onClick={() => void runAdapterUpgrade()}
            size="sm"
            variant="outline"
          >
            {upgrading ? "Updating…" : "Update adapter"}
          </Button>
        </div>
      ) : null}
      {upgrading && outputLine ? (
        <p
          aria-live="polite"
          className="truncate font-mono text-2xs text-muted-foreground"
        >
          {outputLine}
        </p>
      ) : null}

      {info.cli.update_available ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              <span className="font-medium">{label} update available</span>{" "}
              {info.cli.installed} → {info.cli.latest}
            </p>
            {cliLaunched ? (
              <Button
                onClick={() => {
                  setCliLaunched(false);
                  void queryClient.invalidateQueries({
                    queryKey: harnessUpdatesQueryKey,
                  });
                }}
                size="sm"
                variant="outline"
              >
                Check again
              </Button>
            ) : confirmingCli ? null : (
              <Button
                disabled={!info.cli_update_command}
                onClick={() => setConfirmingCli(true)}
                size="sm"
                variant="outline"
              >
                Update {label}
              </Button>
            )}
          </div>
          {cliLaunched ? (
            <p className="text-muted-foreground" role="status">
              Finish the update in the Terminal window, then check again.
            </p>
          ) : null}
          {confirmingCli && info.cli_update_command ? (
            <div className="space-y-2">
              <p className="text-muted-foreground">
                This opens Terminal and runs {label}’s own updater:
              </p>
              <code className="block overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono">
                {info.cli_update_command}
              </code>
              <div className="flex gap-2">
                <Button
                  disabled={launching}
                  onClick={() => void runCliUpdate()}
                  size="sm"
                >
                  Run update
                </Button>
                <Button
                  onClick={() => setConfirmingCli(false)}
                  size="sm"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="whitespace-pre-wrap break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
