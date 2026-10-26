import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ChannelMeeting,
  ChangeMeetingInput,
  MeetingScope,
  SaveMeetingInput,
} from "@/shared/api/meetingTypes";
import {
  changeChannelMeeting,
  getChannelMeetingSupport,
  getChannelMeetings,
  saveChannelMeeting,
} from "@/shared/api/tauriMeetings";
import { useFocusedRefetchInterval } from "@/shared/lib/useDocumentVisible";
import { meetingsQueryKey } from "./meetingPresentation";

/** Refresh remote changes while the visible channel Meetings view is open. */
export function useChannelMeetings(scope: MeetingScope, enabled = true) {
  const interval = useFocusedRefetchInterval(15_000);
  return useQuery({
    queryKey: meetingsQueryKey(scope),
    queryFn: () => getChannelMeetings(scope),
    staleTime: 10_000,
    refetchInterval: interval,
    refetchOnWindowFocus: false,
    retry: 1,
    enabled,
  });
}

/** Keep unsupported relay versions distinct from empty meeting calendars. */
export function useChannelMeetingSupport(scope: MeetingScope) {
  return useQuery({
    queryKey: [...meetingsQueryKey(scope), "support"],
    queryFn: () => getChannelMeetingSupport(scope),
    staleTime: 30_000,
    retry: 1,
  });
}

function useMeetingSaved(scope: MeetingScope) {
  const queryClient = useQueryClient();
  return (saved: ChannelMeeting) => {
    const queryKey = meetingsQueryKey(scope);
    queryClient.setQueryData<ChannelMeeting[]>(queryKey, (existing = []) => [
      ...existing.filter(
        (meeting) =>
          meeting.id !== saved.id ||
          meeting.organizerPubkey !== saved.organizerPubkey,
      ),
      saved,
    ]);
    void queryClient.invalidateQueries({ queryKey, exact: true });
  };
}

/** Save into the captured scope and update only that scope's query cache. */
export function useSaveMeeting(scope: MeetingScope) {
  const onSuccess = useMeetingSaved(scope);
  return useMutation({
    mutationFn: (input: SaveMeetingInput) => saveChannelMeeting(scope, input),
    onSuccess,
  });
}

/** Apply cancellation or an exclusion without retargeting an in-flight action. */
export function useChangeMeeting(scope: MeetingScope) {
  const onSuccess = useMeetingSaved(scope);
  return useMutation({
    mutationFn: (input: ChangeMeetingInput) =>
      changeChannelMeeting(scope, input),
    onSuccess,
  });
}
