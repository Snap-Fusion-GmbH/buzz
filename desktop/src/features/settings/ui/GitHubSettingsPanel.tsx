import { useGitHubAccess } from "@/features/projects/useGitHubAccess";
import { GitHubAccountControls } from "@/features/projects/ui/GitHubAccountControls";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

export function GitHubSettingsPanel() {
  const access = useGitHubAccess();
  return (
    <div className="space-y-6">
      <SettingsSectionHeader description={null} title="GitHub" />
      <GitHubAccountControls access={access} />
    </div>
  );
}
