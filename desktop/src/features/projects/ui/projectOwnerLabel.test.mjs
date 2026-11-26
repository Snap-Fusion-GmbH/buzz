import assert from "node:assert/strict";
import test from "node:test";

import { projectOwnerLabel } from "./ProjectBrowserDialog.tsx";

const me = "75a6a011b208897a4628ad01fcf5332a41ccb73eeac9aafd0afb60659ecb422d";
const other =
  "89a1069a1b438d7bdf692fa50795ab03683c77c30e679f7c042c8101abd6c785";

test("project owners read as You, a name, or a short npub", () => {
  for (const [owner, profiles, expected] of [
    [me, undefined, /^You · npub1wkn/],
    [me.toUpperCase(), undefined, /^You · npub1wkn/],
    [
      other,
      { [other]: { displayName: "Daniel Prokhorov" } },
      /^Daniel Prokhorov · npub13xs/,
    ],
    [
      other,
      { [other]: { displayName: " ", name: "daniel" } },
      /^daniel · npub13xs/,
    ],
    [other, undefined, /^npub13xs/],
  ]) {
    assert.match(projectOwnerLabel(owner, me, profiles), expected);
  }
});
