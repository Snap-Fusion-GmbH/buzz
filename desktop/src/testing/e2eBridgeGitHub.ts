import type { GitHubRepository } from "@/shared/api/github";

type GitHubMock = {
  cliAvailable?: boolean;
  login?: string | null;
  listError?: string;
  accessError?: string;
  remoteCommit?: string;
  calls?: Array<{ command: string; cloneUrl?: string }>;
};

declare global {
  interface Window {
    __BUZZ_E2E_GITHUB__?: GitHubMock;
  }
}

const REPOSITORY: GitHubRepository = {
  id: "6001",
  fullName: "Snap-Fusion-GmbH/private-demo",
  private: true,
  cloneUrl: "https://github.com/Snap-Fusion-GmbH/private-demo.git",
  webUrl: "https://github.com/Snap-Fusion-GmbH/private-demo",
  defaultBranch: "main",
  canPush: true,
  archived: false,
};

/** Synthetic source tree for the private-repository browser journey. */
export function mockGitHubSnapshot(cloneUrl: string | undefined) {
  if (cloneUrl !== REPOSITORY.cloneUrl) return undefined;
  const hash =
    window.__BUZZ_E2E_GITHUB__?.remoteCommit ??
    "0123456789abcdef0123456789abcdef01234567";
  const commit = {
    hash,
    short_hash: hash.slice(0, 7),
    author_name: "Avery Example",
    author_email: "avery@example.com",
    timestamp: 1_792_577_600,
    subject: "Fixture GitHub commit",
  };
  return {
    latest_commit: commit,
    commits: [commit],
    contributors: [
      {
        name: commit.author_name,
        email: commit.author_email,
        commit_count: 1,
        last_commit_at: commit.timestamp,
      },
    ],
    files: [
      {
        path: "README.md",
        kind: "blob",
        size: 22,
        preview_content: "# Private GitHub demo\n",
        last_changed_at: commit.timestamp,
        latest_commit: commit,
      },
    ],
  };
}

export function recordMockGitHubPush(
  cloneUrl: string | undefined,
  commit: string,
) {
  if (cloneUrl === REPOSITORY.cloneUrl && window.__BUZZ_E2E_GITHUB__) {
    window.__BUZZ_E2E_GITHUB__.remoteCommit = commit;
  }
}

/** Fake only native GitHub I/O; project creation/cache/sidebar code stays real. */
export function handleMockGitHub(
  command: string,
  payload: unknown,
  seededBranches: Record<string, string> = {},
): unknown {
  window.__BUZZ_E2E_GITHUB__ ??= {};
  const state = window.__BUZZ_E2E_GITHUB__;
  const cloneUrl = (payload as { cloneUrl?: string } | undefined)?.cloneUrl;
  state.calls ??= [];
  state.calls.push({ command, cloneUrl });
  switch (command) {
    case "get_github_access_status":
      return {
        cliAvailable: state.cliAvailable ?? true,
        login: state.login === undefined ? "avery-e" : state.login,
        organization: "Snap-Fusion-GmbH",
      };
    case "connect_github_account":
      state.login = "avery-e";
      return null;
    case "list_github_repositories":
      if (state.listError) throw new Error(state.listError);
      return [REPOSITORY];
    case "get_github_repository":
      if (state.accessError) throw new Error(state.accessError);
      if (cloneUrl !== REPOSITORY.cloneUrl) {
        throw new Error("GitHub repository is not available.");
      }
      return REPOSITORY;
    case "get_github_repository_state":
      return {
        head: "main",
        branches: Object.entries({
          main:
            state.remoteCommit ?? "0123456789abcdef0123456789abcdef01234567",
          ...seededBranches,
        }).map(([name, commit]) => ({ name, commit })),
        tags: [],
        updatedAt: Math.floor(Date.now() / 1000),
      };
    default:
      throw new Error("Unsupported mock GitHub command");
  }
}
