import * as React from "react";
import type { ChannelMeeting } from "@/shared/api/meetingTypes";
import { useDocumentVisible } from "@/shared/lib/useDocumentVisible";
import { MEETING_NUDGE_LEAD_MS } from "./meetingPresentation";

/** Tick on minute and schedule boundaries, pausing while the document is hidden. */
export function useMeetingClock(meetings: readonly ChannelMeeting[]) {
  const visible = useDocumentVisible();
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      const current = Date.now();
      setNow(current);
      let delay = 60_000 - (current % 60_000);
      for (const meeting of meetings) {
        for (const occurrence of meeting.occurrences) {
          const start = Date.parse(occurrence.starts_at);
          for (const boundary of [
            start - MEETING_NUDGE_LEAD_MS,
            start,
            Date.parse(occurrence.ends_at),
          ]) {
            if (boundary > current) delay = Math.min(delay, boundary - current);
          }
        }
      }
      timer = setTimeout(tick, delay);
    }
    tick();
    return () => clearTimeout(timer);
  }, [meetings, visible]);
  return now;
}
