import { getRelayHttpUrl } from "@/shared/api/tauri";
import {
  getCachedRelayOrigin,
  getRelayOriginGeneration,
  withDeadline,
} from "@/shared/lib/mediaUrl";
import { getIdentity } from "@/shared/api/tauriIdentity";
import {
  buildProjectHomeFromFetcher,
  buildProjectsFromFetcher,
  type FetchProjectEventsExhaustively,
  fetchProjectEventsExhaustively,
} from "./projectEnumeration";
import type { Project } from "./projectModels";
import { markProjectDataAuthoritative } from "./projectSnapshot";

const HIDDEN_PROJECT_CARDS_KEY = "buzz.projects.hidden-cards.v1";

async function projectDiscoveryScope(signal?: AbortSignal) {
  const generation = getRelayOriginGeneration();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (generation !== getRelayOriginGeneration()) {
      throw new Error(
        "The active workspace changed. Refresh projects to retry.",
      );
    }
  };
  assertCurrent();
  const resolved =
    getCachedRelayOrigin() ??
    (await withDeadline(getRelayHttpUrl(), Date.now() + 5_000));
  assertCurrent();
  if (!resolved) {
    throw new Error(
      "Could not resolve the relay address. Refresh projects to retry.",
    );
  }
  const url = new URL(resolved);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "The relay address is invalid. Check the workspace settings.",
    );
  }
  return { relayOrigin: url.origin, assertCurrent };
}

function readHiddenProjectCards(): string[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(HIDDEN_PROJECT_CARDS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Enumerates the projects visible to the current relay identity. */
export async function fetchProjects(
  fetchExhaustively?: FetchProjectEventsExhaustively,
  signal?: AbortSignal,
): Promise<Project[]> {
  // Delegates to `buildProjectsFromFetcher` in `projectEnumeration.ts`, which
  // is the pure, Tauri-free core of this operation. Its javadoc explains
  // fail-closed tombstones and NIP-OA owner-deletion suppression.
  const scope = await projectDiscoveryScope(signal);
  const viewerPubkey = await getIdentity()
    .then((identity) => identity.pubkey)
    .catch(() => undefined);
  scope.assertCurrent();
  const fetcher: FetchProjectEventsExhaustively =
    fetchExhaustively ??
    ((kinds, extraFilter) =>
      fetchProjectEventsExhaustively(kinds, extraFilter, undefined, signal));
  const projects = await buildProjectsFromFetcher(fetcher, {
    relayOrigin: scope.relayOrigin,
    hiddenAddresses: new Set(readHiddenProjectCards()),
    viewerPubkey,
  });
  scope.assertCurrent();
  return projects.map((project) =>
    markProjectDataAuthoritative(project, "relay"),
  );
}

/** Resolves the active channel's project home with a scoped relay query. */
export async function fetchProjectHomeForChannel(
  channelId: string,
  signal?: AbortSignal,
): Promise<Project | null> {
  const scope = await projectDiscoveryScope(signal);
  const viewerPubkey = await getIdentity()
    .then((identity) => identity.pubkey)
    .catch(() => undefined);
  scope.assertCurrent();
  const project = await buildProjectHomeFromFetcher(
    (kinds, extraFilter) =>
      fetchProjectEventsExhaustively(kinds, extraFilter, undefined, signal),
    channelId,
    {
      relayOrigin: scope.relayOrigin,
      hiddenAddresses: new Set(readHiddenProjectCards()),
      viewerPubkey,
    },
  );
  scope.assertCurrent();
  return project ? markProjectDataAuthoritative(project, "relay") : null;
}
