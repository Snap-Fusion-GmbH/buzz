import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../../../preview-features.json", import.meta.url),
    "utf8",
  ),
);

test("existing Projects and Workflows experiments remain unchanged", () => {
  const existing = Object.fromEntries(
    manifest.features
      .filter(({ id }) => id === "projects" || id === "workflows")
      .map((feature) => [feature.id, feature]),
  );

  assert.deepEqual(existing, {
    projects: {
      id: "projects",
      name: "Projects",
      description: "Git repository browser and collaboration",
      // Projects ships on by default; an explicit opt-out still wins.
      defaultEnabled: true,
      platforms: ["desktop"],
    },
    workflows: {
      id: "workflows",
      name: "Workflows",
      description: "YAML-defined automations with approval gates",
      platforms: ["desktop"],
    },
  });
});
