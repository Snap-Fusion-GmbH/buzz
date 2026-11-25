import type { ProjectRepoUploadResult } from "@/shared/api/types";

const LISTED_FILES = 10;

/** A file name as inline code; backticks inside it would break the span. */
function codeSpan(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

/**
 * The channel notice for files added through the app, so people and agents
 * reading the channel learn the repository changed without re-checking it.
 */
export function uploadNoticeContent(
  result: ProjectRepoUploadResult,
  repositoryName: string,
): string {
  const commit = result.commit.slice(0, 7);
  const repository = codeSpan(repositoryName);
  if (result.files.length === 1) {
    return `Added ${codeSpan(result.files[0] ?? "")} to ${repository} (commit ${commit}).`;
  }
  const listed = result.files.slice(0, LISTED_FILES).map(codeSpan).join(", ");
  const more = result.files.length - LISTED_FILES;
  return `Added ${result.files.length} files to ${repository} (commit ${commit}): ${listed}${
    more > 0 ? ` and ${more} more` : ""
  }.`;
}
