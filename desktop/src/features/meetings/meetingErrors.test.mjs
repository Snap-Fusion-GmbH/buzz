import assert from "node:assert/strict";
import test from "node:test";
import { meetingErrorMessage } from "./meetingErrors.ts";

test("an older relay explains the required update and draft recovery", () => {
  for (const error of [
    new Error("relay returned 400 Bad Request: restricted: unknown event kind"),
    "TauriInvokeError: restricted: unsupported event kind",
  ]) {
    const message = meetingErrorMessage(error);
    assert.match(message, /relay needs an update/);
    assert.match(message, /draft is kept/);
    assert.doesNotMatch(message, /TauriInvokeError|400 Bad Request/);
  }
});

test("other failures retain their actionable message rather than becoming success", () => {
  assert.equal(
    meetingErrorMessage(new Error("conflict: meeting changed")),
    "conflict: meeting changed",
  );
  assert.equal(
    meetingErrorMessage("TauriInvokeError: network request timed out"),
    "network request timed out",
  );
});
