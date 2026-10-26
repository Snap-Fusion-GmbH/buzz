import { CalendarDays, Plus, RefreshCw } from "lucide-react";
import * as React from "react";
import type { ChannelMeeting, MeetingScope } from "@/shared/api/meetingTypes";
import type { Channel } from "@/shared/api/types";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import {
  useChangeMeeting,
  useChannelMeetings,
  useChannelMeetingSupport,
} from "../hooks";
import { meetingErrorMessage } from "../meetingErrors";
import {
  formatMeetingTime,
  formatMeetingRange,
  meetingTiming,
  meetingRecurrenceLabel,
  upcomingMeetingSeries,
} from "../meetingPresentation";
import { MeetingEditor, type MeetingDraft } from "./MeetingEditor";
import { MeetingHuddleAction } from "./MeetingHuddleAction";
import { useMeetingClock } from "../useMeetingClock";

type PendingChange = { meeting: ChannelMeeting; skipDate: string | null };
const EMPTY_MEETINGS: ChannelMeeting[] = [];

/** Shared, relay-backed meeting series for one channel, with organizer controls. */
export function ChannelMeetingsPanel({
  channel,
  scope,
}: {
  channel: Channel;
  scope: MeetingScope;
}) {
  const support = useChannelMeetingSupport(scope);
  const query = useChannelMeetings(scope, support.data?.supported === true);
  const change = useChangeMeeting(scope);
  const [draft, setDraft] = React.useState<MeetingDraft | null>(null);
  const [pending, setPending] = React.useState<PendingChange | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const now = useMeetingClock(query.data ?? EMPTY_MEETINGS);
  const meetings = React.useMemo(
    () => upcomingMeetingSeries(query.data ?? EMPTY_MEETINGS, now),
    [query.data, now],
  );
  const canWrite = channel.isMember && !channel.archivedAt;
  function createMeeting() {
    setDraft({ id: crypto.randomUUID(), original: null });
  }
  async function confirmChange() {
    if (!pending || change.isPending) return;
    setError(null);
    try {
      await change.mutateAsync({
        meetingId: pending.meeting.id,
        expectedRevision: pending.meeting.revision,
        skipDate: pending.skipDate,
      });
      setPending(null);
    } catch (failure) {
      setError(meetingErrorMessage(failure));
    }
  }
  return (
    <section
      aria-label="Channel meetings"
      className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-[calc(var(--buzz-channel-content-top-padding,5.75rem)+1rem)]"
      data-testid="channel-meetings"
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Meetings</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Shared dates in #{channel.name}. Meet in this channel’s huddle.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <MeetingHuddleAction channel={channel} />
            <Button
              aria-label="Refresh meetings"
              disabled={query.isFetching || support.isFetching}
              onClick={() => {
                void support.refetch();
                if (support.data?.supported) void query.refetch();
              }}
              size="icon"
              type="button"
              variant="outline"
            >
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
            </Button>
            <Button
              disabled={!canWrite || !support.data?.supported}
              onClick={createMeeting}
              type="button"
            >
              <Plus aria-hidden="true" className="mr-2 h-4 w-4" />
              New meeting
            </Button>
          </div>
        </div>
        {support.data?.supported === false ? (
          <div
            className="space-y-1 rounded-lg border border-border p-4 text-sm"
            role="alert"
          >
            <h3 className="font-medium">Relay update required</h3>
            <p className="text-muted-foreground">
              This workspace’s relay doesn’t support meetings yet. Ask a
              workspace administrator to update it, then use Refresh meetings.
            </p>
          </div>
        ) : null}
        {support.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Could not check meeting support.{" "}
            {meetingErrorMessage(support.error)} Use Refresh meetings to retry.
          </p>
        ) : null}
        {query.isError ? (
          <div
            className="rounded-md border border-destructive/40 p-3 text-sm"
            role="alert"
          >
            Could not refresh meetings. {meetingErrorMessage(query.error)} Your
            existing list is kept; use Refresh meetings to retry.
          </div>
        ) : null}
        {support.isPending || (support.data?.supported && query.isPending) ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading meetings…
          </p>
        ) : meetings.length ? (
          <div className="divide-y divide-border">
            {meetings.map((meeting) => {
              const timing = meetingTiming(meeting, now);
              const next = timing.occurrence;
              const manageable = canWrite && meeting.canManage;
              return (
                <article
                  aria-label={meeting.definition.title}
                  className="space-y-3 py-4"
                  key={`${meeting.organizerPubkey}:${meeting.id}`}
                >
                  <div className="flex flex-wrap justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words font-medium">
                          {meeting.definition.title}
                        </h3>
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-medium ${timing.phase === "in-progress" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                          data-testid="meeting-status"
                        >
                          {timing.label}
                        </span>
                        {timing.detail ? (
                          <span className="text-xs text-muted-foreground">
                            {timing.detail}
                          </span>
                        ) : null}
                      </div>
                      <p className="text-sm" data-testid="meeting-time-range">
                        {next
                          ? formatMeetingRange(
                              next,
                              meeting.definition.timezone,
                            )
                          : "Edit the series to schedule another date."}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {meetingRecurrenceLabel(meeting.definition)} ·{" "}
                        {meeting.definition.duration_minutes} min ·{" "}
                        {meeting.definition.timezone}
                        {meeting.canManage ? " · Organized by you" : ""}
                      </p>
                    </div>
                    {manageable ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          onClick={() =>
                            setDraft({ id: meeting.id, original: meeting })
                          }
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Edit series
                        </Button>
                        {next && timing.phase === "upcoming" ? (
                          <Button
                            onClick={() => {
                              setError(null);
                              setPending({
                                meeting,
                                skipDate: next.local_date,
                              });
                            }}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            Skip next
                          </Button>
                        ) : null}
                        <Button
                          onClick={() => {
                            setError(null);
                            setPending({ meeting, skipDate: null });
                          }}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Cancel series
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {meeting.occurrences.length > 1 ? (
                    <details className="text-sm text-muted-foreground">
                      <summary className="w-fit cursor-pointer">
                        Next dates
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {meeting.occurrences
                          .filter(
                            (occurrence) =>
                              Date.parse(occurrence.starts_at) > now &&
                              occurrence !== next,
                          )
                          .map((occurrence) => (
                            <li key={occurrence.starts_at}>
                              {formatMeetingTime(
                                occurrence.starts_at,
                                meeting.definition.timezone,
                              )}
                            </li>
                          ))}
                      </ul>
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : support.data?.supported && !query.isError ? (
          <div className="space-y-2 py-12 text-center">
            <CalendarDays
              aria-hidden="true"
              className="mx-auto h-7 w-7 text-muted-foreground"
            />
            <h3 className="font-medium">No meetings yet</h3>
            <p className="text-sm text-muted-foreground">
              Create a meeting series to share its upcoming dates with the
              channel.
            </p>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          A reminder appears in Messages five minutes before a meeting and stays
          until its scheduled end. Start or join the huddle when ready; calls
          never start automatically. Background notifications aren’t sent.
        </p>
      </div>
      {draft ? (
        <MeetingEditor
          channelName={channel.name}
          draft={draft}
          key={`${draft.id}:${draft.original?.revision ?? "new"}`}
          onClose={() => setDraft(null)}
          scope={scope}
        />
      ) : null}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !change.isPending) setPending(null);
        }}
        open={pending !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.skipDate
                ? "Skip this occurrence?"
                : "Cancel meeting series?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.skipDate
                ? `Skip ${pending.skipDate} for ${pending.meeting.definition.title}. Later meetings keep their schedule.`
                : `Remove ${pending?.meeting.definition.title ?? "this series"} from upcoming meetings.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={change.isPending}>
              Keep meeting
            </AlertDialogCancel>
            <Button
              disabled={change.isPending}
              onClick={() => void confirmChange()}
              type="button"
            >
              {change.isPending
                ? "Saving…"
                : pending?.skipDate
                  ? "Skip occurrence"
                  : "Cancel series"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
