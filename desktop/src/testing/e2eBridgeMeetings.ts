import type {
  ChannelMeeting,
  ChangeMeetingInput,
  MeetingDefinition,
  MeetingOccurrence,
  MeetingScope,
  SaveMeetingInput,
} from "@/shared/api/meetingTypes";

function localParts(instant: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00`;
}

function localInstant(local: string, timezone: string) {
  const target = new Date(`${local}Z`).getTime();
  let guess = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const shown = new Date(
      `${localParts(new Date(guess), timezone)}Z`,
    ).getTime();
    guess += target - shown;
  }
  const candidates = [guess - 3_600_000, guess, guess + 3_600_000].filter(
    (candidate) => localParts(new Date(candidate), timezone) === local,
  );
  if (!candidates.length)
    throw new Error("first meeting falls in a nonexistent local time");
  return new Date(Math.min(...candidates));
}

function preview(definition: MeetingDefinition): MeetingOccurrence[] {
  if (!definition.title.trim()) throw new Error("meeting title is required");
  if (new TextEncoder().encode(definition.title).length > 256)
    throw new Error("meeting title exceeds 256 bytes");
  localInstant(definition.starts_at, definition.timezone);
  if (definition.status === "cancelled") return [];
  const base = new Date(`${definition.starts_at.slice(0, 10)}T00:00:00Z`);
  if (definition.recurrence === "weekdays" && [0, 6].includes(base.getUTCDay()))
    throw new Error("a weekday meeting must start on a weekday");
  const today = new Date(
    `${localParts(new Date(), definition.timezone).slice(0, 10)}T00:00:00Z`,
  );
  const firstDay = Math.max(
    0,
    Math.floor((today.getTime() - base.getTime()) / 86_400_000),
  );
  const results: MeetingOccurrence[] = [];
  for (
    let day = firstDay;
    day <= firstDay + 1095 && results.length < 3;
    day += 1
  ) {
    if (definition.recurrence === "once" && day > 0) break;
    const date = new Date(base.getTime() + day * 86_400_000);
    const localDate = date.toISOString().slice(0, 10);
    if (definition.recurrence === "weekly" && day % 7) continue;
    if (definition.recurrence === "fortnightly" && day % 14) continue;
    if (
      definition.recurrence === "weekdays" &&
      [0, 6].includes(date.getUTCDay())
    )
      continue;
    if (definition.skipped_dates?.includes(localDate)) continue;
    let start: Date;
    try {
      start = localInstant(
        `${localDate}${definition.starts_at.slice(10)}`,
        definition.timezone,
      );
    } catch {
      continue;
    }
    const end = new Date(
      start.getTime() + definition.duration_minutes * 60_000,
    );
    if (end.getTime() <= Date.now()) continue;
    results.push({
      local_date: localDate,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      nudge_at: null,
    });
  }
  return results;
}

type MeetingResult = { handled: false } | { handled: true; value: unknown };

/** Keep mock meetings behind the same scoped, revision-checked IPC as production. */
export function createMeetingMock() {
  const meetings = new Map<string, ChannelMeeting>();
  let revision = 0;
  return (command: string, payload: unknown, signer: string): MeetingResult => {
    if (command === "preview_meeting_definition") {
      return {
        handled: true,
        value: preview(
          (payload as { definition: MeetingDefinition }).definition,
        ),
      };
    }
    if (
      ![
        "get_channel_meeting_support",
        "get_channel_meetings",
        "save_channel_meeting",
        "change_channel_meeting",
      ].includes(command)
    )
      return { handled: false };
    const request = payload as { scope: MeetingScope } & Partial<
      SaveMeetingInput & ChangeMeetingInput
    >;
    const scope = request.scope;
    if (!scope?.expectedRelayUrl || scope.expectedSignerPubkey !== signer)
      throw new Error("active community or identity changed");
    const supported =
      (
        window as Window & {
          __BUZZ_E2E_MEETINGS_SUPPORTED__?: boolean;
        }
      ).__BUZZ_E2E_MEETINGS_SUPPORTED__ !== false;
    if (command === "get_channel_meeting_support") {
      return { handled: true, value: { supported } };
    }
    if (!supported) throw new Error("restricted: unknown event kind");
    const prefix = `${scope.expectedRelayUrl}:${scope.channelId}:`;
    if (command === "get_channel_meetings") {
      return {
        handled: true,
        value: [...meetings.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([, meeting]) => ({
            ...structuredClone(meeting),
            occurrences: preview(meeting.definition),
            canManage: meeting.organizerPubkey === signer,
          })),
      };
    }
    const key = `${prefix}${signer}:${request.meetingId}`;
    const prior = meetings.get(key);
    if (
      request.expectedRevision &&
      request.expectedRevision !== prior?.revision
    )
      throw new Error(
        "conflict: meeting changed since it was loaded; refresh and try again",
      );
    let definition: MeetingDefinition;
    if (command === "save_channel_meeting") {
      definition = structuredClone(request.definition as MeetingDefinition);
      if (
        prior &&
        !request.expectedRevision &&
        JSON.stringify(prior.definition) !== JSON.stringify(definition)
      )
        throw new Error("conflict: meeting already exists");
    } else {
      if (!prior) throw new Error("meeting not found");
      definition = structuredClone(prior.definition);
      if (request.skipDate)
        definition.skipped_dates = [
          ...new Set([...(definition.skipped_dates ?? []), request.skipDate]),
        ];
      else definition.status = "cancelled";
    }
    const occurrences = preview(definition);
    const saved: ChannelMeeting = {
      id: request.meetingId as string,
      revision: (++revision).toString(16).padStart(64, "0"),
      channelId: scope.channelId,
      organizerPubkey: signer,
      definition,
      occurrences,
      canManage: true,
    };
    meetings.set(key, saved);
    return { handled: true, value: structuredClone(saved) };
  };
}
