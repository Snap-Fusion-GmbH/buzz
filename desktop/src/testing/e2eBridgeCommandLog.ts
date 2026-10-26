/** Snapshot mock IPC payloads without exposing raw bytes or retaining references. */
export function mockCommandLogPayload(payload: unknown): unknown {
  if (payload instanceof Uint8Array)
    return { rawByteLength: payload.byteLength };
  try {
    return JSON.parse(JSON.stringify(payload ?? null));
  } catch {
    return null;
  }
}
