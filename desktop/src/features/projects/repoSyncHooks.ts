import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cloneProjectRepository,
  getProjectRepoSyncStatus,
  pullProjectLocalRepository,
  pickAndUploadProjectFiles,
  pushProjectLocalRepository,
} from "@/shared/api/projectGit";
import type {
  ProjectPullRequest,
  Repository as Project,
} from "@/features/projects/hooks";
import { useProjectRepoHost } from "@/features/projects/useProjectRepoHost";
import { uploadNoticeContent } from "@/features/projects/lib/uploadNotice";
import { sendChannelMessage } from "@/shared/api/tauriMessages";
import { useFocusedRefetchInterval } from "@/shared/lib/useDocumentVisible";
import { publishProjectPullRequestUpdate } from "./pullRequestMutations";

/** Where an upload is announced, captured when the user starts it. */
export type UploadNoticeTarget = {
  channelId: string;
  relayScope: string | null;
  signerScope: string | null;
};

/**
 * Pick, commit and push files, then announce them in the project channel so
 * people and agents there learn the repository changed. The push is the
 * user's commit: a failed notice is reported in `noticeError`, never as a
 * failed upload.
 */
export function useUploadProjectFilesMutation(
  reposDir?: string | null,
  notice?: UploadNoticeTarget | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (project: Project) => {
      if (!project.cloneUrls[0]) throw new Error("No repository selected.");
      // Capture the target before the file picker suspends this call.
      const target = notice ?? null;
      const upload = await pickAndUploadProjectFiles({
        reposDir,
        projectDtag: project.dtag,
        cloneUrl: project.cloneUrls[0],
        defaultBranch: project.defaultBranch,
      });
      if (!upload) return null;
      let noticeError: string | null = null;
      if (target) {
        try {
          await sendChannelMessage(
            target.channelId,
            uploadNoticeContent(upload, project.name || project.dtag),
            null,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            target.relayScope ?? undefined,
            target.signerScope ?? undefined,
          );
        } catch (reason) {
          noticeError =
            reason instanceof Error ? reason.message : String(reason);
        }
      }
      return { upload, noticeError };
    },
    onSuccess: async (result, project) => {
      if (!result) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", project.id] }),
        queryClient.invalidateQueries({
          queryKey: ["projects", "local-repositories"],
        }),
      ]);
    },
  });
}

/** Local-vs-remote git sync status for a project checkout (ahead/behind
 * counts, push/pull availability). Polls gently — each check runs a
 * `git fetch` — and refetches on focus to catch the common "committed in
 * a terminal, switched back to the app" flow. */
export function useProjectRepoSyncStatusQuery(
  project: Project | null | undefined,
  reposDir?: string | null,
  branchName?: string | null,
  baseBranch?: string | null,
) {
  const selectedBranch = branchName ?? project?.defaultBranch ?? null;
  const refetchInterval = useFocusedRefetchInterval(60_000);
  const selectedBaseBranch = baseBranch ?? project?.defaultBranch ?? null;
  const host = useProjectRepoHost(project);

  return useQuery({
    enabled: Boolean(
      (host.kind === "buzz" ||
        (host.kind === "external" && host.host === "github.com")) &&
        project?.cloneUrls[0],
    ),
    queryKey: [
      "project",
      project?.id ?? "none",
      "repo-sync-status",
      reposDir ?? "default",
      selectedBranch ?? "default",
      selectedBaseBranch ?? "default",
    ],
    queryFn: () => {
      if (!project?.cloneUrls[0]) throw new Error("No project selected.");
      return getProjectRepoSyncStatus({
        reposDir,
        projectDtag: project.dtag,
        cloneUrl: project.cloneUrls[0],
        branchName: selectedBranch,
        baseBranch: selectedBaseBranch,
      });
    },
    staleTime: 10_000,
    refetchInterval,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** Pushes local commits to the project remote. */
export function usePushProjectLocalRepositoryMutation(
  project: Project | null | undefined,
  reposDir?: string | null,
  branchName?: string | null,
  pullRequest?: ProjectPullRequest | null,
) {
  const queryClient = useQueryClient();
  const selectedBranch = branchName ?? project?.defaultBranch ?? null;

  return useMutation({
    mutationFn: async () => {
      if (!project?.cloneUrls[0]) throw new Error("No project selected.");
      const result = await pushProjectLocalRepository({
        reposDir,
        projectDtag: project.dtag,
        cloneUrl: project.cloneUrls[0],
        branchName: selectedBranch,
        baseBranch: project.defaultBranch,
      });
      let pullRequestUpdate:
        | { status: "skipped" | "unchanged" | "updated" }
        | { status: "failed"; error: string } = { status: "skipped" };
      if (
        pullRequest &&
        (pullRequest.status === "Open" || pullRequest.status === "Draft")
      ) {
        try {
          const updated = await publishProjectPullRequestUpdate({
            commit: result.commit,
            mergeBase: result.mergeBase,
            project,
            pullRequest,
          });
          pullRequestUpdate = {
            status: updated ? "updated" : "unchanged",
          };
        } catch (error) {
          pullRequestUpdate = {
            status: "failed",
            error:
              error instanceof Error
                ? error.message
                : "The review update could not be published.",
          };
        }
      }
      return { ...result, pullRequestUpdate };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project", project?.id ?? "none"],
      });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/** Clones a project into the workspace repositories directory. */
export function useCloneProjectRepositoryMutation(
  project: Project | null | undefined,
  reposDir?: string | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!project?.cloneUrls[0]) throw new Error("No project selected.");
      return cloneProjectRepository({
        reposDir,
        projectDtag: project.dtag,
        cloneUrl: project.cloneUrls[0],
        defaultBranch: project.defaultBranch,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["project", project?.id ?? "none", "local-repo-snapshot"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["project", project?.id ?? "none", "repo-sync-status"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["projects", "local-repositories"],
        }),
      ]);
    },
  });
}

/** Fast-forwards the local checkout to the remote branch head. */
export function usePullProjectLocalRepositoryMutation(
  project: Project | null | undefined,
  reposDir?: string | null,
  branchName?: string | null,
) {
  const queryClient = useQueryClient();
  const selectedBranch = branchName ?? project?.defaultBranch ?? null;

  return useMutation({
    mutationFn: () => {
      if (!project?.cloneUrls[0]) throw new Error("No project selected.");
      return pullProjectLocalRepository({
        reposDir,
        projectDtag: project.dtag,
        cloneUrl: project.cloneUrls[0],
        branchName: selectedBranch,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project", project?.id ?? "none"],
      });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
