import { useQuery } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import * as React from "react";
import { registerNavigationGuard } from "@/app/navigation/navigationGuard";
import type {
  ChannelMeeting,
  MeetingDefinition,
  MeetingScope,
} from "@/shared/api/meetingTypes";
import { previewMeetingDefinition } from "@/shared/api/tauriMeetings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { useSaveMeeting } from "../hooks";
import { meetingErrorMessage } from "../meetingErrors";
import {
  compatibleMeetingDefinition,
  formatMeetingTime,
  newMeetingDefinition,
} from "../meetingPresentation";
import { MeetingFormFields } from "./MeetingFormFields";

/** A stable editor draft; retries reuse its meeting UUID. */
export type MeetingDraft = { id: string; original: ChannelMeeting | null };

/** Create or update one complete organizer-authored meeting snapshot. */
export function MeetingEditor({
  draft,
  scope,
  channelName,
  onClose,
}: {
  draft: MeetingDraft;
  scope: MeetingScope;
  channelName: string;
  onClose: () => void;
}) {
  const initial = React.useMemo(
    () => draft.original?.definition ?? newMeetingDefinition(),
    [draft.original],
  );
  const [definition, setDefinition] =
    React.useState<MeetingDefinition>(initial);
  const [leaveWarning, setLeaveWarning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const mutation = useSaveMeeting(scope);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const dirty = JSON.stringify(initial) !== JSON.stringify(definition);
  const effectiveDefinition = compatibleMeetingDefinition(definition);
  const removedSkips =
    (definition.skipped_dates?.length ?? 0) -
    (effectiveDefinition.skipped_dates?.length ?? 0);
  React.useEffect(
    () =>
      registerNavigationGuard(() => {
        if (!dirty && !mutation.isPending) return true;
        setLeaveWarning(true);
        return false;
      }),
    [dirty, mutation.isPending],
  );
  const ready =
    definition.title.trim().length > 0 &&
    definition.timezone.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(definition.starts_at);
  const preview = useQuery({
    queryKey: ["meeting-preview", effectiveDefinition],
    queryFn: () => previewMeetingDefinition(effectiveDefinition),
    enabled: ready,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const canSave =
    ready && preview.isSuccess && !preview.isFetching && !mutation.isPending;
  const requestClose = () => {
    if (mutation.isPending) return;
    if (dirty) setLeaveWarning(true);
    else onClose();
  };
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    setError(null);
    try {
      await mutation.mutateAsync({
        meetingId: draft.id,
        definition: { ...effectiveDefinition, title: definition.title.trim() },
        expectedRevision: draft.original?.revision ?? null,
      });
      if (alive.current) onClose();
    } catch (failure) {
      if (alive.current) setError(meetingErrorMessage(failure));
    }
  }
  const id = React.useId();
  return (
    <>
      <Dialog
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
        open
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {draft.original ? "Edit meeting series" : "New meeting"}
            </DialogTitle>
            <DialogDescription>
              Shared with #{channelName}.{" "}
              {draft.original
                ? "Changes apply to future occurrences."
                : "Choose the first date and a local recurrence."}
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-5" onSubmit={(event) => void save(event)}>
            <div className="grid gap-6 sm:grid-cols-2">
              <MeetingFormFields
                definition={definition}
                disabled={mutation.isPending}
                id={id}
                onChange={setDefinition}
              />
              <section
                aria-label="Upcoming meeting dates"
                className="space-y-4"
              >
                <h3 className="flex items-center gap-2 text-sm font-medium">
                  <CalendarDays aria-hidden="true" className="h-4 w-4" />
                  Next meetings
                </h3>
                {preview.data?.length ? (
                  <ul className="space-y-2 text-sm">
                    {preview.data.map((occurrence) => (
                      <li key={occurrence.starts_at}>
                        {formatMeetingTime(
                          occurrence.starts_at,
                          definition.timezone,
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {ready && preview.isSuccess
                      ? "No upcoming occurrence. Check the first date or recurrence."
                      : "Fill in the schedule to preview upcoming dates."}
                  </p>
                )}
                {ready && preview.isError ? (
                  <p className="text-sm text-destructive" role="alert">
                    {meetingErrorMessage(preview.error)}
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {definition.timezone}
                </p>
                {removedSkips > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {removedSkips} skipped date(s) no longer occur in this
                    schedule and will be removed.
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Messages shows an in-app reminder five minutes before the
                  meeting. Start or join the channel huddle when ready.
                  Background notifications aren’t sent.
                </p>
              </section>
            </div>
            {error ? (
              <p
                className="break-words rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                disabled={mutation.isPending}
                onClick={onClose}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={!canSave} type="submit">
                {mutation.isPending
                  ? "Saving…"
                  : draft.original
                    ? "Save series"
                    : "Create meeting"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog onOpenChange={setLeaveWarning} open={leaveWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard meeting changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {mutation.isPending
                ? "A save is still in progress. Wait for its result before leaving."
                : "Save the meeting or discard this draft before leaving the channel."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction disabled={mutation.isPending} onClick={onClose}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
