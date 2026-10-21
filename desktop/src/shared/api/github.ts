import { invokeTauri } from "./tauri";

export type GitHubAccessStatus = {
  cliAvailable: boolean;
  login: string | null;
  organization: string | null;
};

export type GitHubRepository = {
  id: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  webUrl: string;
  defaultBranch: string;
  canPush: boolean;
  archived: boolean;
};

export type GitHubRepositoryState = {
  head: string | null;
  branches: Array<{ name: string; commit: string }>;
  tags: Array<{ name: string; commit: string }>;
  updatedAt: number;
};

/** Classify the host for query routing; native code validates the complete URL. */
export function isGitHubRepositoryUrl(value: string | undefined): boolean {
  try {
    return new URL(value ?? "").hostname === "github.com";
  } catch {
    return false;
  }
}

/** Read only credential-free metadata for the current per-user GitHub account. */
export function getGitHubAccessStatus(): Promise<GitHubAccessStatus> {
  return invokeTauri("get_github_access_status");
}

/** Start official GitHub CLI authorization without receiving an access token. */
export function connectGitHubAccount(): Promise<void> {
  return invokeTauri("connect_github_account");
}

/** List authorized repositories in this managed build's GitHub organization. */
export function listGitHubRepositories(): Promise<GitHubRepository[]> {
  return invokeTauri("list_github_repositories");
}

/** Verify the selected repository's current access and canonical clone URL. */
export function getGitHubRepository(
  cloneUrl: string,
): Promise<GitHubRepository> {
  return invokeTauri("get_github_repository", { cloneUrl });
}

/** Discover branches and tags using the native path-scoped Git credential helper. */
export function getGitHubRepositoryState(
  cloneUrl: string,
): Promise<GitHubRepositoryState> {
  return invokeTauri("get_github_repository_state", { cloneUrl });
}
