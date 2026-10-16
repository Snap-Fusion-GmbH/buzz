import { LoaderCircle, LogIn, RotateCw, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useCommunities } from "@/features/communities/useCommunities";
import { markCommunityOnboardingComplete } from "@/features/onboarding/communityOnboarding";
import { markMachineOnboardingComplete } from "@/features/onboarding/machineOnboarding";
import {
  cancelManagedWorkspaceSignIn,
  getManagedWorkspaceStatus,
  type ManagedWorkspaceStatus,
  signInManagedWorkspace,
} from "@/shared/api/tauriManagedWorkspace";
import { BuzzMark } from "@/shared/ui/buzz-logo/BuzzMark";
import { Button } from "@/shared/ui/button";

export function ManagedWorkspaceGate({ children }: { children: ReactNode }) {
  const { addCommunity, switchCommunity } = useCommunities();
  const [status, setStatus] = useState<ManagedWorkspaceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [prepared, setPrepared] = useState<string | null>(null);
  const generation = useRef(0);
  const pendingRef = useRef(false);

  const check = useCallback(async () => {
    if (pendingRef.current) return;
    const expected = generation.current;
    try {
      const result = await getManagedWorkspaceStatus();
      if (generation.current !== expected || pendingRef.current) return;
      setStatus(result);
      setError(null);
    } catch {
      if (generation.current !== expected || pendingRef.current) return;
      setStatus(null);
      setError("Workspace verification is unavailable.");
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = window.setInterval(() => void check(), 15_000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [check]);

  const readyKey =
    status?.enabled &&
    status.signed_in &&
    status.workspace_id &&
    status.public_key &&
    status.profile
      ? `${status.workspace_id}:${status.public_key}:${status.profile.relay_url}`
      : null;

  useEffect(() => {
    if (
      !readyKey ||
      readyKey === prepared ||
      !status?.profile ||
      !status.public_key ||
      !status.workspace_id
    ) {
      return;
    }
    const communityId = addCommunity({
      id: `managed-${status.workspace_id}`,
      name: status.profile.workspace_name,
      relayUrl: status.profile.relay_url,
      pubkey: status.public_key,
      addedAt: new Date().toISOString(),
    });
    markMachineOnboardingComplete(status.public_key);
    markCommunityOnboardingComplete(
      status.public_key,
      status.profile.relay_url,
    );
    switchCommunity(communityId);
    setPrepared(readyKey);
  }, [addCommunity, prepared, readyKey, status, switchCommunity]);

  async function signIn() {
    if (pendingRef.current) return;
    const expected = ++generation.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await signInManagedWorkspace();
      if (generation.current !== expected) return;
      setStatus(result);
    } catch (reason) {
      if (generation.current !== expected) return;
      setStatus(null);
      setError(
        typeof reason === "string"
          ? reason
          : "Microsoft sign-in was not completed.",
      );
    } finally {
      if (generation.current === expected) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  async function cancel() {
    generation.current += 1;
    await cancelManagedWorkspaceSignIn().catch(() => undefined);
    pendingRef.current = false;
    setPending(false);
    void check();
  }

  if (status?.enabled === false) return <>{children}</>;
  if (readyKey && readyKey === prepared) return <>{children}</>;

  return (
    <main
      className="flex min-h-dvh items-center justify-center bg-background px-6 py-10 text-foreground"
      data-testid="managed-workspace-gate"
    >
      <div className="w-full max-w-sm space-y-6">
        <BuzzMark className="h-10 w-auto" />
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Buzz</h1>
          <p className="text-sm text-muted-foreground">Snap Fusion / R&amp;D</p>
        </header>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {pending ? (
          <div className="flex items-center gap-3" role="status">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span className="text-sm">Waiting for Microsoft</span>
            <Button
              variant="ghost"
              size="icon"
              title="Cancel sign-in"
              aria-label="Cancel sign-in"
              onClick={() => void cancel()}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : status ? (
          <Button className="w-full gap-2" onClick={() => void signIn()}>
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Sign in with Microsoft
          </Button>
        ) : error ? (
          <div className="space-y-3">
            <Button className="w-full gap-2" onClick={() => void signIn()}>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Sign in with Microsoft
            </Button>
            <Button
              variant="outline"
              className="gap-2"
              onClick={() => void check()}
            >
              <RotateCw className="h-4 w-4" aria-hidden="true" />
              Retry verification
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3" role="status">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span className="text-sm">Checking workspace</span>
          </div>
        )}
      </div>
    </main>
  );
}
