/** Prefer the first available agent for a new Projects conversation. */
export function pickDefaultProjectsAgent<
  Agent extends { name: string; personaId?: string | null },
>(agents: readonly Agent[]): Agent | null {
  return agents[0] ?? null;
}
