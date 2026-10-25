import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import UPNG from "upng-js";

const tauriRoot = fileURLToPath(new URL("../src-tauri/", import.meta.url));
const config = JSON.parse(
  readFileSync(path.join(tauriRoot, "tauri.conf.json"), "utf8"),
);

function image(relativePath) {
  const bytes = readFileSync(path.join(tauriRoot, relativePath));
  return UPNG.decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

function pixel(decoded, horizontal, vertical) {
  const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  const offset = (vertical * decoded.width + horizontal) * 4;
  return [...rgba.slice(offset, offset + 4)];
}

test("native packaging references a complete generated icon catalog", () => {
  for (const icon of config.bundle.icon) {
    assert.ok(existsSync(path.join(tauriRoot, icon)), `Missing ${icon}`);
  }
  assert.ok(config.bundle.icon.includes("icons/64x64.png"));
  assert.ok(config.bundle.icon.includes("icons/256x256.png"));
  assert.ok(config.bundle.icon.includes("icons/512x512.png"));
});

for (const size of [16, 32, 56, 64, 112, 128, 168, 256, 512, 1024]) {
  test(`Paired Core ${size}px export retains both corners and separated cores`, () => {
    const decoded = image(`icons/${size}x${size}.png`);
    assert.equal(decoded.width, size);
    assert.equal(decoded.height, size);
    const scale = size / 512;
    const sample = (horizontal, vertical) =>
      pixel(
        decoded,
        Math.floor(horizontal * scale),
        Math.floor(vertical * scale),
      );
    const lime = sample(240, 112);
    const white = sample(272, 400);
    assert.ok(lime[0] > 150 && lime[1] > 160 && lime[2] < 100);
    assert.ok(white.slice(0, 3).every((channel) => channel > 225));
    const gap = sample(256, 256);
    assert.ok(gap.slice(0, 3).every((channel) => channel < 60));
    assert.ok(
      sample(256, 48)
        .slice(0, 3)
        .every((channel) => channel < 60),
    );
  });
}

test("retina and platform containers use the generated native artwork", () => {
  assert.equal(image("icons/128x128@2x.png").width, 256);
  const ico = readFileSync(path.join(tauriRoot, "icons/icon.ico"));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0]);
  const icns = readFileSync(path.join(tauriRoot, "icons/icon.icns"));
  assert.equal(icns.subarray(0, 4).toString(), "icns");
});
