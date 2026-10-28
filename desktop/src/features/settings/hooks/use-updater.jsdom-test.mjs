import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { UpdateChecker } from "../UpdateChecker.tsx";
import { UpdaterProvider, useUpdaterContext } from "./UpdaterProvider.tsx";
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

test("Debian updates respect the install layout and retry denied installation without restarting", async () => {
  const calls = [];
  const openedUrls = [];
  const packageUrl =
    "https://updates.example.invalid/staging/Buzz_0.5.40_amd64.deb";
  const originalInternals = window.__TAURI_INTERNALS__;
  const originalGlobalInternals = globalThis.__TAURI_INTERNALS__;
  let supportsUpdate = false;
  let allowInstall = false;
  let updater;
  const internals = {
    transformCallback: () => 1,
    invoke: async (command, args) => {
      calls.push(command);
      switch (command) {
        case "plugin:updater|check":
          return {
            rid: 1,
            currentVersion: "0.5.39",
            version: "0.5.40",
            rawJson: {
              platforms: { "linux-x86_64-deb": { url: packageUrl } },
            },
          };
        case "is_auto_update_supported":
          return supportsUpdate;
        case "plugin:updater|download":
          return 2;
        case "plugin:updater|install":
          if (!allowInstall)
            throw new Error("Administrator authorization denied");
          return;
        case "plugin:resources|close":
        case "plugin:process|restart":
          return;
        case "plugin:opener|open_url":
          openedUrls.push(args.url);
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
    updater = useUpdaterContext();
    return React.createElement(UpdateChecker);
  }
  async function clickButton(label) {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === label,
    );
    assert.ok(button, `Missing button: ${label}`);
    await act(async () => button.click());
  }
  try {
    await act(async () =>
      root.render(
        React.createElement(
          UpdaterProvider,
          null,
          React.createElement(Harness),
        ),
      ),
    );
    assert.equal(updater.status.state, "manual-required");
    assert.equal(updater.status.releaseUrl, packageUrl);
    assert.equal(calls.includes("plugin:updater|download"), false);
    assert.equal(calls.includes("plugin:updater|install"), false);
    assert.equal(calls.includes("plugin:resources|close"), true);
    assert.match(container.textContent, /system package manager/);
    assert.doesNotMatch(container.textContent, /Switch to the AppImage/);
    await clickButton("Download Update");
    assert.deepEqual(openedUrls, [packageUrl]);
    supportsUpdate = true;
    await act(async () => updater.checkForUpdate());
    assert.equal(updater.status.state, "ready");
    assert.equal(calls.includes("plugin:updater|install"), false);
    await clickButton("Update Now");
    assert.equal(updater.status.state, "error");
    assert.match(updater.status.message, /authorization denied/);
    assert.equal(calls.includes("plugin:process|restart"), false);
    assert.match(container.textContent, /authorization denied/);
    allowInstall = true;
    await clickButton("Retry");
    assert.equal(updater.status.state, "ready");
    assert.equal(calls.includes("plugin:process|restart"), false);
    await clickButton("Update Now");
    assert.deepEqual(calls.slice(-2), [
      "plugin:updater|install",
      "plugin:process|restart",
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.__TAURI_INTERNALS__ = originalInternals;
    globalThis.__TAURI_INTERNALS__ = originalGlobalInternals;
  }
});
