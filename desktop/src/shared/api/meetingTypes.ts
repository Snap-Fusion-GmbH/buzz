/** The organizer-authored NIP-CM meeting JSON contract. */
export type MeetingDefinition = {
  version: 1;
  title: string;
  starts_at: string;
  timezone: string;
  duration_minutes: number;
  recurrence: "once" | "weekly" | "fortnightly" | "weekdays";
  status: "active" | "cancelled";
  nudge_minutes_before?: number | null;
  skipped_dates?: string[];
};

/** Whether the selected relay advertises the meeting protocol. */
export type MeetingSupport = {
  supported: boolean;
};

/** A concrete occurrence resolved by the shared Rust recurrence model. */
export type MeetingOccurrence = {
  local_date: string;
  starts_at: string;
  ends_at: string;
  nudge_at: string | null;
};

/** Caller-captured scope required for every meeting read and write. */
export type MeetingScope = {
  channelId: string;
  expectedRelayUrl: string;
  expectedSignerPubkey: string;
};

/** One verified live meeting head and its upcoming dates. */
export type ChannelMeeting = {
  id: string;
  revision: string;
  channelId: string;
  organizerPubkey: string;
  definition: MeetingDefinition;
  occurrences: MeetingOccurrence[];
  canManage: boolean;
};

/** A stable meeting draft, reused after an ambiguous create failure. */
export type SaveMeetingInput = {
  meetingId: string;
  definition: MeetingDefinition;
  expectedRevision: string | null;
};

/** A revision-checked cancellation or single-date exclusion. */
export type ChangeMeetingInput = {
  meetingId: string;
  expectedRevision: string;
  skipDate: string | null;
};
