import * as React from "react";

import {
  useAcpAuthMethodsQuery,
  useAcpRuntimesQueryForced,
  useConnectAcpRuntimeMutation,
} from "@/features/agents/hooks";
import type { AcpAuthMethod, AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { runtimeIsReadyForOnboarding } from "./onboardingRuntimeSelection";

function isSupportedOnboardingAuthMethod(
  runtime: AcpRuntimeCatalogEntry,
  method: AcpAuthMethod,
) {
  if (runtime.id !== "codex") return true;
  return !/api[-_ ]?key/i.test(`${method.id} ${method.name}`);
}

function isPreferredClaudeAuthMethod(method: AcpAuthMethod) {
  const haystack = [
    method.id,
    method.name,
    method.description ?? "",
    method.command.join(" "),
    method.args.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("claudeai") ||
    haystack.includes("claude ai") ||
    haystack.includes("claude.ai") ||
    haystack.includes("subscription")
  );
}

export function getOnboardingAuthMethods(
  runtime: AcpRuntimeCatalogEntry,
  methods: AcpAuthMethod[],
) {
  const supported = methods.filter((method) =>
    isSupportedOnboardingAuthMethod(runtime, method),
  );

  if (runtime.id === "claude") {
    const preferred =
      supported.find(isPreferredClaudeAuthMethod) ?? supported[0];
    return preferred ? [preferred] : [];
  }

  if (runtime.id === "codex") {
    return supported.slice(0, 1);
  }

  return supported;
}

/**
 * Sign a signed-out CLI runtime in through its own login flow, then poll the
 * runtime catalog until the sign-in lands (bounded at two minutes). Buzz only
 * starts the vendor's login; it never reads the CLI's credentials.
 *
 * Shares the surface owner's forced runtime query, so it never mounts its own
 * forced probe (see `useAcpRuntimesQueryForced`).
 */
export function useRuntimeSignIn(
  runtime: AcpRuntimeCatalogEntry,
  { enabled }: { enabled: boolean },
) {
  const shouldSignIn =
    runtime.availability === "available" &&
    runtime.authStatus.status === "logged_out";
  const methodsQuery = useAcpAuthMethodsQuery(runtime.id, {
    enabled: shouldSignIn && enabled,
  });
  const connectMutation = useConnectAcpRuntimeMutation();
  const runtimesQuery = useAcpRuntimesQueryForced({ forceOnMount: false });
  const [isWaitingForSignIn, setIsWaitingForSignIn] = React.useState(false);
  const [didSignInCheckTimeOut, setDidSignInCheckTimeOut] =
    React.useState(false);
  const isReady = runtimeIsReadyForOnboarding(runtime);

  React.useEffect(() => {
    if (!isWaitingForSignIn || !isReady) return;
    setIsWaitingForSignIn(false);
    setDidSignInCheckTimeOut(false);
  }, [isReady, isWaitingForSignIn]);

  React.useEffect(() => {
    if (!isWaitingForSignIn) return;

    const interval = window.setInterval(() => {
      void runtimesQuery.forceRefresh();
    }, 2_000);
    const timeout = window.setTimeout(() => {
      setIsWaitingForSignIn(false);
      setDidSignInCheckTimeOut(true);
    }, 120_000);

    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
    };
  }, [isWaitingForSignIn, runtimesQuery.forceRefresh]);

  const authMethod =
    getOnboardingAuthMethods(runtime, methodsQuery.data?.methods ?? [])[0] ??
    null;

  const start = () => {
    if (didSignInCheckTimeOut) {
      setDidSignInCheckTimeOut(false);
      setIsWaitingForSignIn(true);
      void runtimesQuery.forceRefresh();
      return;
    }
    if (!authMethod) {
      void methodsQuery.refetch();
      return;
    }
    connectMutation.mutate(
      { methodId: authMethod.id, runtimeId: runtime.id },
      { onSuccess: () => setIsWaitingForSignIn(true) },
    );
  };

  return {
    shouldSignIn,
    isWaitingForSignIn,
    didSignInCheckTimeOut,
    start,
    methodsFailed: methodsQuery.error instanceof Error,
    connectFailed: connectMutation.error instanceof Error,
  };
}
