import { readFileSync } from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../desktop/packages/markdown-math/test-fixtures/basic.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { basic: string };

export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: "math-readme-test-fixture",
        transformIndexHtml() {
          const cells = Array.from({ length: 20 }, () => "x_{123}").join(" & ");
          const examples = JSON.stringify({
            basic: fixture.basic,
            wide: `Inline matrix $\\begin{matrix}${cells}\\end{matrix}$.`,
          }).replaceAll("<", "\\u003c");
          return [
            {
              tag: "script",
              attrs: { type: "module" },
              children: `import { mockRepoReadme } from "/src/features/repos/mock-repos.ts";
const examples = ${examples};
mockRepoReadme.content = new URLSearchParams(location.search).get("math") === "wide"
  ? examples.wide : examples.basic;`,
              injectTo: "head-prepend",
            },
          ];
        },
      },
    ],
  }),
);
