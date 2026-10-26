import { invokeTauri } from "@/shared/api/tauri";
import type {
  ChannelMeeting,
  ChangeMeetingInput,
  MeetingDefinition,
  MeetingOccurrence,
  MeetingScope,
  MeetingSupport,
  SaveMeetingInput,
} from "./meetingTypes";

/** Discover support on the captured relay before offering meeting writes. */
export function getChannelMeetingSupport(scope: MeetingScope) {
  return invokeTauri<MeetingSupport>("get_channel_meeting_support", { scope });
}

/** Read meeting heads through the initiating channel/community identity. */
export function getChannelMeetings(scope: MeetingScope) {
  return invokeTauri<ChannelMeeting[]>("get_channel_meetings", { scope });
}

/** Resolve validated upcoming dates without publishing any state. */
export function previewMeetingDefinition(definition: MeetingDefinition) {
  return invokeTauri<MeetingOccurrence[]>("preview_meeting_definition", {
    definition,
  });
}

/** Publish one organizer-authored meeting snapshot with a revision guard. */
export function saveChannelMeeting(
  scope: MeetingScope,
  input: SaveMeetingInput,
) {
  return invokeTauri<ChannelMeeting>("save_channel_meeting", {
    scope,
    ...input,
  });
}

/** Cancel a series or skip one occurrence through the same captured scope. */
export function changeChannelMeeting(
  scope: MeetingScope,
  input: ChangeMeetingInput,
) {
  return invokeTauri<ChannelMeeting>("change_channel_meeting", {
    scope,
    ...input,
  });
}
