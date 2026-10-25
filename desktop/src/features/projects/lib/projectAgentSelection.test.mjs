import assert from "node:assert/strict";
import test from "node:test";

import { pickDefaultProjectsAgent } from "./projectAgentSelection.ts";

test("uses the first available agent", () => {
  const implementationPartner = {
    name: "Implementation Partner",
    personaId: "custom:implementation",
  };
  const fizz = { name: "Fizz", personaId: "builtin:fizz" };
  assert.equal(
    pickDefaultProjectsAgent([implementationPartner, fizz]),
    implementationPartner,
  );
});

test("returns null when there are no agents", () => {
  assert.equal(pickDefaultProjectsAgent([]), null);
});
