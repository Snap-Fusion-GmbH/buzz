import type { CreateProjectInput } from "@/features/projects/useCreateProject";
import { Dialog } from "@/shared/ui/dialog";
import { CreateProjectFormContent } from "./CreateProjectFormContent";
import * as React from "react";
import { GitHubImportForm } from "./GitHubImportForm";

type CreateProjectDialogProps = {
  isCreating: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
};

/** Modal for creating a project channel. */
export function CreateProjectDialog({
  isCreating,
  onCreate,
  onOpenChange,
  open,
}: CreateProjectDialogProps) {
  const [github, setGitHub] = React.useState(false);
  React.useEffect(() => {
    if (open) setGitHub(false);
  }, [open]);
  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen && isCreating) return;
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      {github ? (
        <GitHubImportForm
          active={open}
          isCreating={isCreating}
          onBack={() => setGitHub(false)}
          onCreate={onCreate}
          onCreated={() => onOpenChange(false)}
        />
      ) : (
        <CreateProjectFormContent
          active={open}
          isCreating={isCreating}
          onCreate={onCreate}
          onCreated={() => onOpenChange(false)}
          onChooseGitHub={() => setGitHub(true)}
        />
      )}
    </Dialog>
  );
}
