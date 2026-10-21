import { Download, LogIn, RefreshCw } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import type { useGitHubAccess } from "../useGitHubAccess";
import { Button } from "@/shared/ui/button";
import { GitHubMark } from "./GitHubMark";

export function GitHubAccountControls({
  access,
}: {
  access: ReturnType<typeof useGitHubAccess>;
}) {
  const { status, connect } = access;
  const error = status.error ?? connect.error;
  return (
    <div className="space-y-2" data-testid="github-account-controls">
      <div className="flex min-h-12 flex-wrap items-center gap-3">
        <GitHubMark aria-hidden="true" className="h-5 w-5 shrink-0" />
        <div className="min-w-0 flex-1 text-sm" aria-live="polite">
          <div className="break-words font-medium">
            {status.isLoading
              ? "Checking GitHub..."
              : status.data?.login
                ? status.data.login
                : status.data?.cliAvailable === false
                  ? "GitHub CLI unavailable"
                  : "GitHub not connected"}
          </div>
          {status.data?.organization ? (
            <div className="break-words text-xs text-muted-foreground">
              {status.data.organization}
            </div>
          ) : null}
        </div>
        {status.data?.cliAvailable === false ? (
          <Button
            onClick={() => {
              void openUrl("https://cli.github.com").catch(() =>
                toast.error("Could not open GitHub CLI downloads."),
              );
            }}
            size="sm"
            variant="outline"
          >
            <Download className="h-4 w-4" />
            GitHub CLI
          </Button>
        ) : (
          <Button
            data-testid="github-connect"
            disabled={status.isLoading || connect.isPending}
            onClick={() => connect.mutate()}
            size="sm"
            variant="outline"
          >
            <LogIn className="h-4 w-4" />
            {status.data?.login ? "Change account" : "Connect GitHub"}
          </Button>
        )}
        <Button
          aria-label="Refresh GitHub account"
          disabled={status.isFetching}
          onClick={() => {
            connect.reset();
            void status.refetch();
          }}
          size="icon"
          title="Refresh GitHub account"
          variant="ghost"
        >
          <RefreshCw
            className={status.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"}
          />
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error instanceof Error ? error.message : "GitHub connection failed."}
        </p>
      ) : null}
    </div>
  );
}
