import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, LoaderCircle } from "lucide-react";

import {
  useAcpRuntimesQueryForced,
  useInstallAcpAdapterMutation,
  useInstallAcpRuntimeMutation,
} from "@/features/agents/hooks";
import { useInstallOutputLine } from "@/features/agents/lib/useInstallOutputLine";
import { HarnessUpdateNotice } from "@/features/agents/ui/HarnessUpdateNotice";
import {
  agentToolSetupRuntimes,
  agentToolStatus,
  automaticAdapterInstalls,
} from "@/features/onboarding/agentToolSetup";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { getInstallErrorMessage } from "@/shared/lib/installError";
import { PairedCoreMark } from "@/shared/ui/buzz-logo/PairedCoreMark";
import { Button } from "@/shared/ui/button";
import { RuntimeIcon } from "./RuntimeIcon";
import { useRuntimeSignIn } from "./useRuntimeSignIn";

type InstallMode = "adapter" | "full";

type RowProps = {
  error: string | null;
  installed: boolean;
  installing: boolean;
  /** Another runtime is installing: installs run one at a time. */
  installBusy: boolean;
  onCheckAgain: () => void;
  onInstall: (mode: InstallMode) => void;
  runtime: AcpRuntimeCatalogEntry;
};

function Spinner({ label }: { label: string }) {
  return (
    <LoaderCircle
      aria-label={label}
      className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
      role="img"
    />
  );
}

function AgentToolRow({
  error,
  installBusy,
  installed,
  installing,
  onCheckAgain,
  onInstall,
  runtime,
}: RowProps) {
  const status = agentToolStatus(runtime);
  const signIn = useRuntimeSignIn(runtime, {
    enabled: status.kind === "signed_out",
  });
  const label = runtime.label;
  // The installer's latest output line (download, npm, …) as live progress.
  const outputLine = useInstallOutputLine(runtime.id, installing);

  let detail: React.ReactNode;
  let action: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (installing) {
    detail =
      status.kind === "cli_missing"
        ? `Installing ${label} and its adapter…`
        : "Installing adapter…";
    action = <Spinner label={`Installing ${label}`} />;
    body = (
      <div className="space-y-1.5">
        <div
          aria-hidden="true"
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full w-full animate-pulse rounded-full bg-primary/60" />
        </div>
        <p
          aria-live="polite"
          className="truncate font-mono text-2xs leading-4 text-muted-foreground"
          data-testid={`agent-tool-${runtime.id}-install-output`}
        >
          {outputLine ?? "Starting…"}
        </p>
      </div>
    );
  } else if (error) {
    detail = "Install failed";
    body = (
      <p className="whitespace-pre-wrap break-words text-xs text-destructive">
        {error}
      </p>
    );
    action = (
      <Button
        disabled={installBusy}
        onClick={() =>
          onInstall(status.kind === "cli_missing" ? "full" : "adapter")
        }
        size="sm"
        variant="outline"
      >
        Retry
      </Button>
    );
  } else if (status.kind === "ready") {
    detail = "Ready";
    body = <HarnessUpdateNotice runtime={runtime} />;
    action = (
      <Check aria-label="Ready" className="h-4 w-4 text-primary" role="img" />
    );
  } else if (status.kind === "adapter_needed") {
    if (installed) {
      detail = "Adapter installed · checking…";
      action = <Spinner label={`Checking ${label}`} />;
    } else if (status.automatic) {
      detail = "CLI found · installing adapter…";
      action = <Spinner label={`Installing ${label}`} />;
    } else {
      detail = runtime.installHint || "The ACP adapter is missing.";
      action = (
        <Button
          onClick={() => void openUrl(runtime.installInstructionsUrl)}
          size="sm"
          variant="outline"
        >
          Install guide
        </Button>
      );
    }
  } else if (status.kind === "cli_missing") {
    detail = "Not installed on this computer";
    body = (
      <div className="space-y-2">
        {runtime.cliInstallCommand ? (
          <>
            <p className="text-xs text-muted-foreground">
              Buzz doesn’t install {label} without asking. Installing runs:
            </p>
            <code className="block overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
              {runtime.cliInstallCommand}
            </code>
          </>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {runtime.cliInstallCommand ? (
            <Button
              disabled={installBusy}
              onClick={() => onInstall("full")}
              size="sm"
            >
              Install {label}
            </Button>
          ) : null}
          <Button
            onClick={() => void openUrl(runtime.installInstructionsUrl)}
            size="sm"
            variant="ghost"
          >
            Install it myself
          </Button>
        </div>
      </div>
    );
  } else if (status.kind === "signed_out") {
    detail = signIn.isWaitingForSignIn
      ? "Finish signing in in the Terminal or browser window that opened."
      : signIn.didSignInCheckTimeOut
        ? "Sign-in not detected yet"
        : signIn.connectFailed
          ? "Couldn’t start sign-in. Try again."
          : "Signed out";
    action = (
      <Button
        disabled={signIn.isWaitingForSignIn || signIn.isPreparing}
        onClick={() => void signIn.start()}
        size="sm"
      >
        {signIn.isPreparing
          ? "Preparing sign-in…"
          : signIn.isWaitingForSignIn
            ? "Waiting for sign-in…"
            : signIn.didSignInCheckTimeOut
              ? "Check again"
              : `Sign in to ${label}`}
      </Button>
    );
  } else {
    detail = status.detail ?? "Couldn’t confirm the sign-in state.";
    action = (
      <Button onClick={onCheckAgain} size="sm" variant="outline">
        Check again
      </Button>
    );
  }

  return (
    <li
      className="space-y-3 rounded-xl border border-border px-4 py-3"
      data-testid={`agent-tool-${runtime.id}`}
    >
      <div className="flex items-center gap-3">
        <RuntimeIcon className="h-8 w-8 shrink-0" runtime={runtime} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p
            className="text-xs text-muted-foreground"
            data-testid={`agent-tool-${runtime.id}-status`}
            role="status"
          >
            {detail}
          </p>
        </div>
        {action}
      </div>
      {body}
    </li>
  );
}

/**
 * First-run agent tool setup for managed workspaces: finds the Claude Code
 * and Codex CLIs, installs their missing ACP adapters automatically, and asks
 * before running any vendor CLI installer. Skipping is always possible.
 */
export function AgentToolSetupScreen({
  onDone,
  workspaceName,
}: {
  onDone: () => void;
  workspaceName: string;
}) {
  const runtimesQuery = useAcpRuntimesQueryForced();
  const { mutateAsync: installAdapter } = useInstallAcpAdapterMutation();
  const { mutateAsync: installRuntime } = useInstallAcpRuntimeMutation();
  const [firstCheckDone, setFirstCheckDone] = React.useState(false);
  const [installing, setInstalling] = React.useState<string | null>(null);
  const [installed, setInstalled] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  // Each automatic install is attempted once; afterwards only Retry runs it.
  const attempted = React.useRef(new Set<string>());
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  React.useEffect(() => {
    if (runtimesQuery.hasForcedCheckStarted && !runtimesQuery.isFetching) {
      setFirstCheckDone(true);
    }
  }, [runtimesQuery.hasForcedCheckStarted, runtimesQuery.isFetching]);

  const catalog = runtimesQuery.data ?? [];
  const runtimes = agentToolSetupRuntimes(catalog);

  const install = React.useCallback(
    async (runtimeId: string, mode: InstallMode) => {
      setInstalling(runtimeId);
      setErrors(({ [runtimeId]: _, ...rest }) => rest);
      let failure: string | null = null;
      try {
        const result =
          mode === "adapter"
            ? await installAdapter(runtimeId)
            : await installRuntime(runtimeId);
        if (!result.success) failure = getInstallErrorMessage(result);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (!mounted.current) return;
      if (failure) {
        setErrors((current) => ({ ...current, [runtimeId]: failure }));
      } else {
        setInstalled((current) => new Set(current).add(runtimeId));
      }
      setInstalling(null);
    },
    [installAdapter, installRuntime],
  );

  const nextAutomatic = firstCheckDone
    ? automaticAdapterInstalls(catalog).find((id) => !attempted.current.has(id))
    : undefined;
  React.useEffect(() => {
    if (!nextAutomatic || installing) return;
    attempted.current.add(nextAutomatic);
    void install(nextAutomatic, "adapter");
  }, [install, installing, nextAutomatic]);

  const checkFailed =
    firstCheckDone && runtimesQuery.isError && runtimes.length === 0;
  const allReady =
    firstCheckDone &&
    runtimes.length > 0 &&
    runtimes.every((runtime) => agentToolStatus(runtime).kind === "ready");
  const busy = !firstCheckDone || installing !== null;

  const title = !firstCheckDone
    ? "Setting up your agent tools"
    : checkFailed
      ? "Couldn’t check your agent tools"
      : allReady
        ? "Your agents are ready"
        : installing
          ? "Connecting your agents"
          : "Almost there";
  const description = !firstCheckDone
    ? "Buzz is checking this computer for Claude Code and Codex, so your agents can start working right away."
    : allReady
      ? "Agents you create can use these tools, or the built-in Buzz agent. Manage them anytime in Settings → Agents."
      : "Buzz installs the adapters it needs into its own folder, so no admin password is needed. You can finish anything left later in Settings → Agents.";

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-10 text-foreground"
      data-testid="agent-tool-setup"
    >
      <section
        aria-labelledby="agent-tool-setup-title"
        className="w-full max-w-lg space-y-6"
      >
        <PairedCoreMark className="h-12 w-12" />
        <header className="space-y-2">
          <p className="text-sm text-muted-foreground">{workspaceName}</p>
          <h1 className="text-2xl font-semibold" id="agent-tool-setup-title">
            {title}
          </h1>
          <p className="text-sm text-muted-foreground">{description}</p>
        </header>

        {!firstCheckDone ? (
          <div className="flex items-center gap-3" role="status">
            <Spinner label="Checking" />
            <span className="text-sm">Looking for Claude Code and Codex…</span>
          </div>
        ) : checkFailed ? (
          <Button
            onClick={() => void runtimesQuery.forceRefresh()}
            variant="outline"
          >
            Check again
          </Button>
        ) : (
          <ul className="space-y-2">
            {runtimes.map((runtime) => (
              <AgentToolRow
                error={errors[runtime.id] ?? null}
                installBusy={installing !== null && installing !== runtime.id}
                installed={installed.has(runtime.id)}
                installing={installing === runtime.id}
                key={runtime.id}
                onCheckAgain={() => void runtimesQuery.forceRefresh()}
                onInstall={(mode) => {
                  if (!installing) void install(runtime.id, mode);
                }}
                runtime={runtime}
              />
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between gap-3">
          {allReady ? (
            <span />
          ) : (
            <Button onClick={onDone} variant="ghost">
              Skip for now
            </Button>
          )}
          <Button disabled={busy} onClick={onDone}>
            {allReady ? "Open Buzz" : busy ? "Setting up…" : "Continue"}
          </Button>
        </div>
      </section>
    </main>
  );
}
