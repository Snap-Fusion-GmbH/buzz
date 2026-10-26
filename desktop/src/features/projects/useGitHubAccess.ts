import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  connectGitHubAccount,
  getGitHubAccessStatus,
} from "@/shared/api/github";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { useIdentityQuery } from "@/shared/api/hooks";

export function useGitHubAccess() {
  const client = useQueryClient();
  const relay = useRelayOrigin();
  const identity = useIdentityQuery();
  const scope = [relay ?? "none", identity.data?.pubkey ?? "none"] as const;
  const status = useQuery({
    queryKey: ["github", ...scope, "access"],
    queryFn: getGitHubAccessStatus,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: "always",
  });
  const connect = useMutation({
    mutationFn: connectGitHubAccount,
    onSuccess: () => client.invalidateQueries({ queryKey: ["github"] }),
  });
  return { status, connect, scope };
}
