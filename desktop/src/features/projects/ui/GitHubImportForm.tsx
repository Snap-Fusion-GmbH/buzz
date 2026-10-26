import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw } from "lucide-react";
import * as React from "react";
import { listGitHubRepositories } from "@/shared/api/github";
import type { CreateProjectInput } from "../useCreateProject";
import { useGitHubAccess } from "../useGitHubAccess";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Input } from "@/shared/ui/input";
import { GitHubAccountControls } from "./GitHubAccountControls";

export function GitHubImportForm({
  active,
  isCreating,
  onBack,
  onCreate,
  onCreated,
}: {
  active: boolean;
  isCreating: boolean;
  onBack: () => void;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onCreated: () => void;
}) {
  const access = useGitHubAccess();
  const login = access.status.data?.login;
  const [relayScope, identityScope] = access.scope;
  const repositories = useQuery({
    queryKey: [
      "github",
      ...access.scope,
      "repositories",
      login,
      access.status.data?.organization,
    ],
    queryFn: listGitHubRepositories,
    enabled: active && Boolean(login) && !access.status.isError,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const [repositoryId, setRepositoryId] = React.useState("");
  const [name, setName] = React.useState("");
  const [consent, setConsent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const repository = repositories.data?.find(
    (candidate) => candidate.id === repositoryId,
  );

  React.useEffect(() => {
    if (
      login === undefined ||
      relayScope === "none" ||
      identityScope === "none"
    )
      return;
    setRepositoryId("");
    setName("");
    setConsent(false);
    setError(null);
  }, [login, relayScope, identityScope]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!repository || !consent || !name.trim() || isCreating) return;
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        githubRepository: repository,
        shareGitHubMetadata: true,
        channelVisibility: "private",
        projectVisibility: "unlisted",
        templateId: "",
      });
      onCreated();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not add GitHub project.",
      );
    }
  }

  return (
    <ChooserDialogContent
      className="max-w-lg"
      data-testid="github-import-dialog"
      title="Add from GitHub"
      footer={
        <Button
          data-testid="github-import-submit"
          disabled={isCreating || !repository || !consent || !name.trim()}
          form="github-import-form"
          type="submit"
        >
          {isCreating ? "Adding..." : "Add project"}
        </Button>
      }
    >
      <Button disabled={isCreating} onClick={onBack} size="sm" variant="ghost">
        <ArrowLeft className="h-4 w-4" />
        Back
      </Button>
      <GitHubAccountControls access={access} />
      <form
        className="space-y-5 pt-3"
        id="github-import-form"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              className="text-sm font-medium"
              htmlFor="github-import-repository"
            >
              Repository
            </label>
            <Button
              aria-label="Refresh GitHub repositories"
              disabled={!login || repositories.isFetching || isCreating}
              onClick={() => {
                void repositories.refetch();
              }}
              size="icon"
              title="Refresh GitHub repositories"
              type="button"
              variant="ghost"
            >
              <RefreshCw
                className={
                  repositories.isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"
                }
              />
            </Button>
          </div>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            data-testid="github-import-repository"
            disabled={!login || repositories.isLoading || isCreating}
            id="github-import-repository"
            onChange={(event) => {
              const selected = repositories.data?.find(
                (candidate) => candidate.id === event.target.value,
              );
              setRepositoryId(event.target.value);
              setName(selected?.fullName.split("/").at(-1) ?? "");
              setConsent(false);
              setError(null);
            }}
            value={repositoryId}
          >
            <option value="">
              {repositories.isFetching
                ? "Loading repositories..."
                : "Select repository"}
            </option>
            {(repositories.data ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.fullName}
                {candidate.private ? " (private)" : ""}
                {!candidate.canPush ? " (read-only)" : ""}
              </option>
            ))}
          </select>
          {repositories.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {repositories.error.message}
            </p>
          ) : repositories.isSuccess && repositories.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No repositories available.
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="github-import-name">
            Project name
          </label>
          <Input
            data-testid="github-import-name"
            disabled={isCreating}
            id="github-import-name"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </div>
        <div className="flex items-start gap-3">
          <Checkbox
            checked={consent}
            disabled={isCreating}
            id="github-import-consent"
            onCheckedChange={(value) => setConsent(value === true)}
          />
          <label className="text-sm leading-5" htmlFor="github-import-consent">
            Share this repository&apos;s name and link with this Buzz workspace
          </label>
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </ChooserDialogContent>
  );
}
