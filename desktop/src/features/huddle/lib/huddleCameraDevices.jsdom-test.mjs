import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
let nativeCameraError = null;
const tauri = {
  transformCallback: () => 1,
  invoke: async (command) => {
    if (command === "get_huddle_state")
      return {
        phase: "active",
        ephemeral_channel_id: CHANNEL,
        camera_share: null,
        camera_error: nativeCameraError,
      };
    if (command === "plugin:event|listen") return 1;
    if (command === "plugin:event|unlisten") return null;
    throw new Error(`Unexpected native operation: ${command}`);
  },
};
window.__TAURI_INTERNALS__ = tauri;
globalThis.__TAURI_INTERNALS__ = tauri;
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
const { relayClient } = await import("@/shared/api/relayClient");
relayClient.subscribeLive = async () => {};
relayClient.subscribeToConnectionState = () => () => {};
relayClient.subscribeToChannelAccessRevocations = () => () => {};
const { HuddleCameraProvider, useHuddleCamera } = await import(
  "../HuddleCameraContext.tsx"
);

const camera = (deviceId = "usb") => ({
  kind: "videoinput",
  deviceId,
  label: `Camera ${deviceId}`,
});
const previous = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
let root;
let container;
let latest;
let devices;
let calls;
let announcements;

function Probe() {
  latest = useHuddleCamera();
  return null;
}

async function render(channelId = CHANNEL) {
  await act(async () => {
    root.render(
      React.createElement(
        HuddleCameraProvider,
        { channelId, ownsCapture: true },
        React.createElement(Probe),
      ),
    );
  });
}

beforeEach(() => {
  nativeCameraError = null;
  calls = 0;
  announcements = new Set();
  devices = new window.EventTarget();
  const source = devices;
  devices.enumerateDevices = async () => {
    calls++;
    // Keep a regressed feedback loop finite so the regression fails promptly.
    if (calls > 3) throw new Error("Enumeration feedback loop");
    const timer = setTimeout(() => {
      announcements.delete(timer);
      source.dispatchEvent(new Event("devicechange"));
    }, 0);
    announcements.add(timer);
    return [camera()];
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: devices,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const timer of announcements) clearTimeout(timer);
  container.remove();
  if (previous) Object.defineProperty(navigator, "mediaDevices", previous);
  else delete navigator.mediaDevices;
});

test("the production camera provider never enumerates while idle or from devicechange storms", async () => {
  await render(null);
  assert.equal(calls, 0);
  await render();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(calls, 1, "huddle entry permits one probe");
  assert.deepEqual(latest.cameras, [{ deviceId: "usb", label: "Camera usb" }]);
  await act(async () => {
    for (let index = 0; index < 20; index++)
      devices.dispatchEvent(new Event("devicechange"));
  });
  assert.equal(
    calls,
    1,
    "WebKit re-announcements must not feed another enumeration",
  );
  await act(async () => latest.refresh());
  assert.equal(calls, 2, "explicit refresh permits one additional probe");
});

test("overlapping camera refreshes share one probe and preserve an unchanged list", async () => {
  await render();
  const initial = latest.cameras;
  let resolve;
  devices.enumerateDevices = () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  };
  let first;
  let second;
  await act(async () => {
    first = latest.refresh();
    second = latest.refresh();
  });
  assert.equal(calls, 2);
  assert.equal(latest.checking, true);
  await act(async () => {
    resolve([camera()]);
    await Promise.all([first, second]);
  });
  assert.equal(latest.cameras, initial);
  assert.equal(latest.checking, false);
});

test("a late camera probe cannot repopulate a room that was left", async () => {
  let resolve;
  devices.enumerateDevices = () =>
    new Promise((done) => {
      resolve = done;
    });
  await render();
  assert.equal(latest.checking, true);
  await render(null);
  await act(async () => resolve([camera("late")]));
  assert.deepEqual(latest.cameras, []);
  assert.equal(latest.checking, false);
});

test("camera enumeration failures remain visible and explicit retry clears only that error", async () => {
  await render();
  const initial = latest.cameras;
  devices.enumerateDevices = async () => {
    throw new Error("Device monitor failed");
  };
  await act(async () => latest.refresh());
  assert.match(latest.error, /Device monitor failed/);
  assert.equal(latest.cameras, initial);
  assert.equal(latest.checking, false);
  devices.enumerateDevices = async () => [camera("replacement")];
  await act(async () => latest.refresh());
  assert.equal(latest.error, null);
  assert.deepEqual(latest.cameras, [
    { deviceId: "replacement", label: "Camera replacement" },
  ]);
});

test("refreshing device discovery does not erase a native camera failure", async () => {
  nativeCameraError = "Camera disconnected";
  await render();
  await act(async () => latest.refresh());
  assert.equal(latest.error, "Camera disconnected");
});
