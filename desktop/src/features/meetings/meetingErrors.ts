/** Explain version mismatches without leaking IPC wrapper names into the UI. */
export function meetingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/(?:unknown|unsupported) event kind/i.test(message)) {
    return "This workspace's relay needs an update before it can save meetings. Your draft is kept; retry after the relay has been updated.";
  }
  return message.replace(/^TauriInvokeError:\s*/, "");
}
