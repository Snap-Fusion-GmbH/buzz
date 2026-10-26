import { CalendarDays } from "lucide-react";
import type { ChannelMeeting, MeetingScope } from "@/shared/api/meetingTypes";
import type { Channel } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { useChannelMeetings, useChannelMeetingSupport } from "../hooks";
import {
  meetingTiming,
  meetingsNeedingAttention,
} from "../meetingPresentation";
import { useMeetingClock } from "../useMeetingClock";
import { MeetingHuddleAction } from "./MeetingHuddleAction";

const EMPTY_MEETINGS: ChannelMeeting[] = [];

/** Keep imminent meetings visible above Messages without opening a call. */
export function ChannelMeetingNudge({
  channel,
  scope,
  onOpenMeetings,
}: {
  channel: Channel;
  scope: MeetingScope;
  onOpenMeetings: () => void;
}) {
  const support = useChannelMeetingSupport(scope);
  const query = useChannelMeetings(scope, support.data?.supported === true);
  const meetings = query.data ?? EMPTY_MEETINGS;
  const now = useMeetingClock(meetings);
  const attention = meetingsNeedingAttention(meetings, now);
  if (support.isError || query.isError) {
    return (
      <div className="pointer-events-auto flex items-center justify-between gap-3 border-b border-border bg-background px-5 py-2 text-xs text-muted-foreground">
        Meeting status unavailable.
        <Button onClick={onOpenMeetings} size="sm" variant="ghost">
          View meetings
        </Button>
      </div>
    );
  }
  const meeting = attention[0];
  if (!meeting || !channel.isMember || channel.archivedAt) return null;
  const timing = meetingTiming(meeting, now);
  return (
    <section
      aria-label="Meeting reminder"
      className="pointer-events-auto flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/70 px-5 py-3"
      data-testid="channel-meeting-nudge"
    >
      <div className="flex min-w-0 items-center gap-3">
        <CalendarDays aria-hidden="true" className="h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {meeting.definition.title}
            {attention.length > 1 ? ` +${attention.length - 1} more` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {timing.phase === "in-progress" ? "Scheduled now" : timing.detail}
            {timing.phase === "in-progress" ? ` · ${timing.detail}` : ""}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button onClick={onOpenMeetings} size="sm" variant="ghost">
          View meetings
        </Button>
        <MeetingHuddleAction channel={channel} />
      </div>
    </section>
  );
}
