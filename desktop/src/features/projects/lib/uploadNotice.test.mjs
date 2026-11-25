import assert from "node:assert/strict";
import test from "node:test";

import { uploadNoticeContent } from "./uploadNotice.ts";

const upload = (files) => ({
  branch: "main",
  commit: "494e3d8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e",
  files,
  path: "/tmp/repo",
});

test("upload notices name the files, repository and commit", () => {
  for (const [files, repository, expected] of [
    [
      ["2610.27165v1.pdf"],
      "some-test",
      "Added `2610.27165v1.pdf` to `some-test` (commit 494e3d8).",
    ],
    [
      ["a.txt", "b`c.md"],
      "docs",
      "Added 2 files to `docs` (commit 494e3d8): `a.txt`, `b'c.md`.",
    ],
    [
      Array.from({ length: 12 }, (_, index) => `f${index}`),
      "bulk",
      "Added 12 files to `bulk` (commit 494e3d8): `f0`, `f1`, `f2`, `f3`, `f4`, `f5`, `f6`, `f7`, `f8`, `f9` and 2 more.",
    ],
  ]) {
    assert.equal(uploadNoticeContent(upload(files), repository), expected);
  }
});
