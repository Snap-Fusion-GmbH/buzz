import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useUpdater } from "./use-updater.ts";

test("checks at startup and every fifteen minutes, downloads before an explicit restart", async () => {
  const calls = [];
  const intervals = new Map();
  let available = false;
  let updater;
  let intervalId = 0;
  const originalSetInterval = window.setInterval;
  const originalClearInterval = window.clearInterval;
  const originalInternals = window.__TAURI_INTERNALS__;
  const originalGlobalInternals = globalThis.__TAURI_INTERNALS__;
  window.setInterval = (callback, delay) => {
    const identifier = ++intervalId;
    intervals.set(identifier, { callback, delay });
    return identifier;
  };
  window.clearInterval = (identifier) => intervals.delete(identifier);
  const internals = {
    transformCallback: () => 1,
    invoke: async (command) => {
      calls.push(command);
      switch (command) {
        case "plugin:updater|check":
          return available
            ? { rid: 1, currentVersion: "0.5.30", version: "0.5.31" }
            : null;
        case "is_auto_update_supported":
          return true;
        case "plugin:updater|download":
          return 2;
        case "plugin:updater|install":
        case "plugin:process|restart":
        case "plugin:resources|close":
          return;
        default:
          throw new Error(`Unexpected native call: ${command}`);
      }
    },
  };
  window.__TAURI_INTERNALS__ = internals;
  globalThis.__TAURI_INTERNALS__ = internals;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    updater = useUpdater();
    return React.createElement("span", null, updater.status.state);
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.deepEqual(calls, ["plugin:updater|check"]);
    assert.equal(intervals.size, 1);
    const timer = [...intervals.values()][0];
    assert.equal(timer.delay, 15 * 60 * 1000);
    await act(async () => timer.callback());
    assert.equal(
      calls.filter((call) => call === "plugin:updater|check").length,
      2,
    );
    available = true;
    await act(async () => timer.callback());
    assert.equal(container.textContent, "ready");
    assert.equal(calls.includes("plugin:updater|download"), true);
    assert.equal(calls.includes("plugin:updater|install"), false);
    const checks = calls.filter(
      (call) => call === "plugin:updater|check",
    ).length;
    await act(async () => timer.callback());
    assert.equal(
      calls.filter((call) => call === "plugin:updater|check").length,
      checks,
    );
    await act(async () => updater.installAndRelaunch());
    assert.deepEqual(calls.slice(-2), [
      "plugin:updater|install",
      "plugin:process|restart",
    ]);
  } finally {
    await act(async () => root.unmount());
    assert.equal(intervals.size, 0);
    container.remove();
    window.setInterval = originalSetInterval;
    window.clearInterval = originalClearInterval;
    window.__TAURI_INTERNALS__ = originalInternals;
    globalThis.__TAURI_INTERNALS__ = originalGlobalInternals;
  }
});
