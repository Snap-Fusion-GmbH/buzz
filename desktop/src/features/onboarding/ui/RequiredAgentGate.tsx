import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import {
  useAcpRuntimesQuery,
  useCreatePersonaMutation,
  usePersonasQuery,
} from "@/features/agents/hooks";
import { resolveManagedAgentAvatarUrl } from "@/features/agents/ui/managedAgentAvatar";
import { getDiscoveredPersonaModelOptions } from "@/features/agents/ui/usePersonaModelDiscovery";
import {
  defaultAgentName,
  harnessesNeedingAgent,
} from "@/features/onboarding/agentToolSetup";
import { discoverAgentModels } from "@/shared/api/agentModels";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { PairedCoreMark } from "@/shared/ui/buzz-logo/PairedCoreMark";
import { Button } from "@/shared/ui/button";
import { RuntimeIcon } from "./RuntimeIcon";

const FIELD_CLASS =
  "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RequiredAgentForm({
  position,
  runtime,
  total,
  workspaceName,
}: {
  position: number;
  runtime: AcpRuntimeCatalogEntry;
  total: number;
  workspaceName: string;
}) {
  const { mutateAsync: createPersona } = useCreatePersonaMutation();
  const [name, setName] = React.useState(() => defaultAgentName(runtime));
  const [model, setModel] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const agentCommand = runtime.command ?? "";
  const modelsQuery = useQuery({
    queryKey: ["required-agent-models", runtime.id, agentCommand],
    queryFn: () =>
      discoverAgentModels({ agentCommand, agentArgs: runtime.defaultArgs }),
    enabled: agentCommand.length > 0,
    retry: 1,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const modelOptions = getDiscoveredPersonaModelOptions(
    modelsQuery.data ?? null,
    "",
    runtime.id,
  ) ?? [{ id: "", label: "Default model" }];
  const label = runtime.label;
  const trimmedName = name.trim();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmedName || pending) return;
    setPending(true);
    setError(null);
    try {
      const avatarUrl = await resolveManagedAgentAvatarUrl(
        undefined,
        undefined,
        runtime.avatarUrl,
      );
      await createPersona({
        displayName: trimmedName,
        systemPrompt: "",
        runtime: runtime.id,
        model: model || undefined,
        avatarUrl,
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : typeof reason === "string"
            ? reason
            : "Couldn’t create the agent. Try again.",
      );
      setPending(false);
    }
  }

  return (
    <form
      aria-labelledby="required-agent-title"
      className="w-full max-w-lg space-y-6"
      data-testid={`required-agent-${runtime.id}`}
      onSubmit={(event) => void submit(event)}
    >
      <PairedCoreMark className="h-12 w-12" />
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {workspaceName}
          {total > 1 ? ` · Agent ${position} of ${total}` : null}
        </p>
        <h1 className="text-2xl font-semibold" id="required-agent-title">
          Set up your {label} agent
        </h1>
        <p className="text-sm text-muted-foreground">
          {label} is ready on this computer, but you don’t have a {label} agent
          yet. Create one to start working with it. You can change its
          instructions and settings anytime under Agents.
        </p>
      </header>

      <div className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
        <RuntimeIcon className="h-8 w-8 shrink-0" runtime={runtime} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">Ready · signed in</p>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="required-agent-name">
          Agent name
        </label>
        <input
          autoComplete="off"
          className={FIELD_CLASS}
          id="required-agent-name"
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="required-agent-model">
          Model
        </label>
        <select
          className={FIELD_CLASS}
          disabled={modelsQuery.isLoading}
          id="required-agent-model"
          onChange={(event) => setModel(event.target.value)}
          value={model}
        >
          {modelOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <p
          className="text-xs text-muted-foreground"
          data-testid="required-agent-model-status"
          role="status"
        >
          {modelsQuery.isLoading
            ? "Loading models…"
            : modelsQuery.isError
              ? `Couldn’t load ${label} models; the agent will use ${label}’s default model.`
              : null}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button disabled={!trimmedName || pending} type="submit">
          {pending ? "Creating…" : `Create ${label} agent`}
        </Button>
      </div>
    </form>
  );
}

/**
 * Keeps Buzz closed until every ready agent harness (installed and signed in)
 * has an agent of the user's own. A harness that is missing or signed out
 * never blocks, and an unreadable catalog or agent list lets the user in
 * rather than trapping them behind a check that cannot complete.
 */
export function RequiredAgentGate({
  children,
  workspaceName,
}: {
  children: React.ReactNode;
  workspaceName: string;
}) {
  const runtimesQuery = useAcpRuntimesQuery();
  const personasQuery = usePersonasQuery();
  // Count the harnesses that needed an agent when this gate first saw them,
  // so "Agent 2 of 2" stays stable while agents are created.
  const [initialCount, setInitialCount] = React.useState<number | null>(null);

  const loading =
    (runtimesQuery.isLoading && !runtimesQuery.data) ||
    (personasQuery.isLoading && !personasQuery.data);
  const needed =
    runtimesQuery.data && personasQuery.data
      ? harnessesNeedingAgent(runtimesQuery.data, personasQuery.data)
      : [];

  React.useEffect(() => {
    if (!loading && initialCount === null) setInitialCount(needed.length);
  }, [initialCount, loading, needed.length]);

  if (loading) {
    return (
      <main
        className="flex min-h-dvh items-center justify-center bg-background text-foreground"
        data-testid="required-agent-checking"
      >
        <div className="flex items-center gap-3" role="status">
          <LoaderCircle
            aria-hidden="true"
            className="h-4 w-4 animate-spin text-muted-foreground"
          />
          <span className="text-sm">Checking your agents…</span>
        </div>
      </main>
    );
  }

  const next = needed[0];
  if (!next) return <>{children}</>;

  const total = Math.max(initialCount ?? needed.length, needed.length);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-10 text-foreground">
      <RequiredAgentForm
        key={next.id}
        position={total - needed.length + 1}
        runtime={next}
        total={total}
        workspaceName={workspaceName}
      />
    </main>
  );
}
