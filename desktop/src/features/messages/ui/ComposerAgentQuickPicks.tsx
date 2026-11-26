import * as React from "react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import type { MentionSuggestion } from "./MentionAutocomplete";

/** The user's own configured agents, as mention suggestions, by name. */
export function useComposerQuickPickAgents(
  enabled: boolean,
): MentionSuggestion[] {
  const agentsQuery = useManagedAgentsQuery({ enabled });
  const agents = agentsQuery.data;
  return React.useMemo(
    () =>
      (agents ?? [])
        .filter((agent) => agent.pubkey && agent.name.trim())
        .map((agent) => ({
          agentProvenance: "managed-here" as const,
          avatarUrl: agent.avatarUrl,
          displayName: agent.name.trim(),
          isAgent: true,
          kind: "identity" as const,
          pubkey: normalizePubkey(agent.pubkey),
        }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [agents],
  );
}

/**
 * One-click "Use <agent>" above the composer: mentions the agent without
 * typing `@`. In a thread the agent stays pinned (highlighted here) until its
 * avatar's remove button clears it.
 */
export function ComposerAgentQuickPicks({
  activePubkeys,
  agents,
  disabled,
  onUse,
}: {
  activePubkeys: ReadonlySet<string>;
  agents: readonly MentionSuggestion[];
  disabled?: boolean;
  onUse: (agent: MentionSuggestion) => void;
}) {
  if (agents.length === 0) return null;
  return (
    <fieldset
      className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 border-0 px-1 py-0"
      data-testid="composer-agent-quick-picks"
    >
      <legend className="sr-only">Agents</legend>
      {agents.map((agent) => {
        const pubkey = agent.pubkey ?? "";
        const active = activePubkeys.has(pubkey);
        const label = `Use ${agent.displayName}`;
        return (
          <Tooltip disableHoverableContent key={pubkey}>
            <TooltipTrigger asChild>
              <button
                aria-label={label}
                className={cn(
                  "inline-flex h-7 max-w-44 items-center gap-1.5 rounded-full border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
                  active
                    ? "border-primary/50 bg-primary/15 text-foreground"
                    : "border-border/60 bg-background/70 text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                data-testid={`composer-agent-quick-pick-${pubkey}`}
                disabled={disabled}
                onClick={() => onUse(agent)}
                // Keep the editor's selection: using an agent edits the draft.
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <span aria-hidden="true" className="shrink-0">
                  <UserAvatar
                    avatarUrl={agent.avatarUrl ?? null}
                    className="h-4.5 w-4.5"
                    displayName={agent.displayName}
                    shape="squircle"
                    size="xs"
                  />
                </span>
                <span className="truncate">{agent.displayName}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}
