import type {
  ChannelMeeting,
  MeetingDefinition,
  MeetingOccurrence,
  MeetingScope,
} from "@/shared/api/meetingTypes";

/** Isolate cached meetings by the complete initiating community identity. */
export const meetingsQueryKey = (scope: MeetingScope) =>
  [
    "channel-meetings",
    scope.expectedRelayUrl,
    scope.expectedSignerPubkey,
    scope.channelId,
  ] as const;

/** Default a new meeting to 09:00 on the next local calendar date. */
export function newMeetingDefinition(
  now = new Date(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): MeetingDefinition {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const tomorrow = new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day) + 1,
    ),
  );
  return {
    version: 1,
    title: "",
    starts_at: `${tomorrow.toISOString().slice(0, 10)}T09:00:00`,
    timezone,
    duration_minutes: 30,
    recurrence: "weekly",
    status: "active",
    skipped_dates: [],
  };
}

/** Describe the protocol recurrence without translating it into UTC cron. */
export function meetingRecurrenceLabel(definition: MeetingDefinition) {
  switch (definition.recurrence) {
    case "once":
      return "One time";
    case "weekdays":
      return "Monday–Friday";
    case "fortnightly":
      return "Every two weeks";
    case "weekly":
      return "Every week";
  }
}

/** Keep only exclusions that still occur after an edit to the calendar anchor. */
export function compatibleMeetingDefinition(
  definition: MeetingDefinition,
): MeetingDefinition {
  const anchor = Date.parse(`${definition.starts_at.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(anchor)) return definition;
  return {
    ...definition,
    skipped_dates: definition.skipped_dates?.filter((date) => {
      const instant = new Date(`${date}T00:00:00Z`);
      const elapsed = (instant.getTime() - anchor) / 86_400_000;
      if (!Number.isInteger(elapsed) || elapsed < 0) return false;
      switch (definition.recurrence) {
        case "once":
          return elapsed === 0;
        case "weekly":
          return elapsed % 7 === 0;
        case "fortnightly":
          return elapsed % 14 === 0;
        case "weekdays":
          return ![0, 6].includes(instant.getUTCDay());
      }
      return false;
    }),
  };
}

/** Format a validated occurrence, falling back explicitly to UTC on older clients. */
export function formatMeetingTime(instant: string, timezone: string) {
  const date = new Date(instant);
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** Show both ends in the meeting zone, including offset changes and midnight. */
export function formatMeetingRange(
  occurrence: MeetingOccurrence,
  timezone: string,
) {
  const start = new Date(occurrence.starts_at);
  const end = new Date(occurrence.ends_at);
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    });
    const zone = (date: Date) =>
      formatter.formatToParts(date).find((part) => part.type === "timeZoneName")
        ?.value;
    return zone(start) === zone(end)
      ? formatter.formatRange(start, end)
      : `${formatter.format(start)} – ${formatter.format(end)}`;
  } catch {
    return `${formatMeetingTime(occurrence.starts_at, "UTC")} – ${formatMeetingTime(occurrence.ends_at, "UTC")} UTC`;
  }
}

/** Roll cached dates forward at their exclusive end boundary. */
export function nextMeetingOccurrence(
  meeting: ChannelMeeting,
  now: number,
): MeetingOccurrence | undefined {
  return meeting.occurrences.find(
    (occurrence) => Date.parse(occurrence.ends_at) > now,
  );
}

/** Describe scheduled time without implying that an audio room is active. */
export function meetingTiming(meeting: ChannelMeeting, now: number) {
  const occurrence = nextMeetingOccurrence(meeting, now);
  if (!occurrence) {
    return {
      phase: meeting.definition.recurrence === "once" ? "ended" : "unscheduled",
      label:
        meeting.definition.recurrence === "once"
          ? "Ended"
          : "No upcoming occurrence",
      detail: null,
      occurrence,
    } as const;
  }
  const startsIn = Date.parse(occurrence.starts_at) - now;
  const remaining = Date.parse(occurrence.ends_at) - now;
  if (startsIn <= 0) {
    return {
      phase: "in-progress",
      label: "In progress",
      detail: `${Math.ceil(remaining / 60_000)} min left`,
      occurrence,
    } as const;
  }
  const minutes = Math.ceil(startsIn / 60_000);
  return {
    phase: "upcoming",
    label: "Upcoming",
    detail:
      minutes < 60
        ? `Starts in ${minutes} min`
        : minutes < 1_440
          ? `Starts in ${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`
          : null,
    occurrence,
  } as const;
}

export const MEETING_NUDGE_LEAD_MS = 5 * 60_000;

/** Select in-channel reminders without creating notifications or audio sessions. */
export function meetingsNeedingAttention(
  meetings: ChannelMeeting[],
  now: number,
) {
  return upcomingMeetingSeries(meetings, now).filter((meeting) => {
    const occurrence = nextMeetingOccurrence(meeting, now);
    return (
      occurrence &&
      Date.parse(occurrence.starts_at) - now <= MEETING_NUDGE_LEAD_MS
    );
  });
}

/** Preserve expired one-time series as editable rows instead of hiding recovery. */
export function upcomingMeetingSeries(
  meetings: ChannelMeeting[],
  now = Date.now(),
) {
  return meetings
    .filter((meeting) => meeting.definition.status === "active")
    .sort((left, right) => {
      const leftStart = nextMeetingOccurrence(left, now)?.starts_at ?? "\uffff";
      const rightStart =
        nextMeetingOccurrence(right, now)?.starts_at ?? "\uffff";
      return (
        leftStart.localeCompare(rightStart) ||
        left.definition.title.localeCompare(right.definition.title) ||
        left.id.localeCompare(right.id)
      );
    });
}
