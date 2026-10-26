import { FolderGit2 } from "lucide-react";

import type { Project, Repository } from "@/features/projects/hooks";
import { Button } from "@/shared/ui/button";
import { ChooserDialogContent } from "@/shared/ui/chooser-dialog-content";
import { Dialog } from "@/shared/ui/dialog";

export function ProjectFileRepositoryDialog({
  isUploading,
  onOpenChange,
  onSelect,
  open,
  project,
  uploadableRepositoryIds,
}: {
  isUploading: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (repository: Repository) => void;
  open: boolean;
  project: Project;
  uploadableRepositoryIds: ReadonlySet<string>;
}) {
  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isUploading) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <ChooserDialogContent
        className="max-w-lg"
        contentClassName="space-y-1 pt-2"
        data-testid="project-file-repository-dialog"
        headerSubtitle={`Choose a repository in ${project.name}. Selected files will be committed and pushed to its current branch.`}
        title="Add files to repository"
      >
        {project.repositories.map((repository) => {
          const uploadable = uploadableRepositoryIds.has(repository.id);
          return (
            <Button
              className="h-auto w-full justify-start gap-3 rounded-lg px-3 py-3 text-left"
              data-testid={`project-file-repository-${repository.dtag}`}
              disabled={isUploading || !uploadable}
              key={repository.id}
              onClick={() => onSelect(repository)}
              type="button"
              title={
                uploadable
                  ? `Add files to ${repository.name}`
                  : "Only Buzz-hosted repositories support file uploads"
              }
              variant="ghost"
            >
              <FolderGit2
                aria-hidden="true"
                className="h-5 w-5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-foreground">
                  {repository.name}
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {uploadable
                    ? "Commit and push selected files"
                    : "External repository"}
                </span>
              </span>
            </Button>
          );
        })}
      </ChooserDialogContent>
    </Dialog>
  );
}
