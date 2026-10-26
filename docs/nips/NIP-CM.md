# NIP-CM: Channel Meetings

`draft` · `optional`

Channel meetings are organizer-authored, channel-scoped addressable events of
kind **30623**. Their recurrence is expressed in the meeting's local timezone,
not as a fixed UTC cron expression.

## Implemented surface

Stream channels in the desktop app have Messages and Meetings tabs. Meetings
shows the next occurrence of each active series, expandable upcoming dates,
and organizer controls to create, edit, skip one occurrence, or cancel a series.
Expired one-time meetings remain editable. Drafts survive failed saves; stale
edits report a conflict instead of overwriting another device's changes.

The SDK, relay, and `buzz meetings` CLI share the same validated calendar model.
Management is restricted to the signing organizer; channel-admin editing is
not implemented. The desktop tab is scoped to the ordinary stream-channel view,
not forums, DMs, or auxiliary thread/profile/management views.

Messages displays an **in-app meeting reminder** from five minutes before an
occurrence until its scheduled end, while that channel is open. Meetings shows
24-hour start–end ranges in the meeting timezone, live Upcoming/In progress/Ended
states, and an explicit Start/Join/Open channel huddle action. In progress
describes scheduled time, not proof that somebody has joined a call. The
ordinary channel huddle is reused; creating a meeting or reaching its start
never automatically opens audio or enables a microphone.

Durable background channel-nudge delivery is **not implemented**. The in-app
reminder is not a server-posted message, an OS notification, or a promise of
delivery while Buzz or the channel is closed. The list and editor state this
limitation; no shared nudge configuration is enabled.

This keeps the notification default in `VISION.md`: no channel noise without an
explicit opt-in. There is no external calendar synchronization, location picker,
or preparation-note field.

## Compatibility and rollout

The relay advertises `nip-cm` in the NIP-11 `supported_extensions` array.
Deploy relay support before distributing the desktop feature. Desktop reads
the existing `/info` document through the captured community scope before
offering creation; an older relay shows **Relay update required**, not a
misleading empty calendar. Refresh checks again after an upgrade.

Native reads and writes also verify support. A version mismatch retains the
editor draft and explains the required relay update instead of exposing a raw
IPC error. Support does not imply automatic reminder delivery.

## Event envelope

```json
{
  "kind": 30623,
  "tags": [
    ["h", "<channel-uuid>"],
    ["d", "<channel-uuid>:<meeting-uuid>"],
    ["expected-revision", "none"]
  ],
  "content": "<meeting JSON>"
}
```

Exactly one two-element `h` tag and one two-element `d` tag are required. UUIDs
use canonical lowercase hyphenated form. Binding the channel into the `d` tag
prevents a replacement from moving a meeting to another channel. The full
address is `(organizer pubkey, 30623, channel_uuid:meeting_uuid)`.

The relay applies its ordinary community boundary, channel write authorization,
and channel read visibility. Meeting writes require `messages:write`. Existing
NIP-33 replacement ordering supplies the winning head.

An optional, single two-element `expected-revision` tag makes the write
conditional: `none` requires no existing head, and a hexadecimal event ID
requires that exact current head. The check and replacement run atomically
under the existing coordinate lock. A mismatch is an HTTP 409 or rejected
WebSocket write. An exact replay of an accepted signed event is successful,
but a superseded write is not. Events without the tag retain normal NIP-33
behavior for compatibility.

The SDK, desktop, and CLI use these preconditions for all new writes. Clients
read the current head with strong consistency and use a strictly newer
timestamp for updates.

## Content

```json
{
  "version": 1,
  "title": "Weekly team sync",
  "starts_at": "2026-10-26T10:00:00",
  "timezone": "Europe/Berlin",
  "duration_minutes": 30,
  "recurrence": "weekly",
  "status": "active",
  "skipped_dates": []
}
```

- `version`: required; currently `1`.
- `title`: nonblank, at most 256 UTF-8 bytes, no control characters.
- `starts_at`: first local date/time, with minute precision and no UTC offset.
- `timezone`: valid IANA timezone.
- `duration_minutes`: elapsed duration between 1 and 1440 minutes.
- `recurrence`: `once` (default), `weekly`, `fortnightly`, or `weekdays`.
- `status`: `active` (default) or `cancelled`.
- `nudge_minutes_before`: optional lead time between 1 and 1440 minutes;
  absence means no shared nudge. This is scheduling metadata, not a delivery
  guarantee; the initial implementation has no delivery worker.
- `skipped_dates`: at most 128 distinct local occurrence dates. Skipping a date
  does not shift the recurrence anchor.

The serialized definition is limited to 8192 bytes. Unknown content fields are
rejected rather than silently discarded.

## Recurrence and DST

Weekly and fortnightly meetings stay on the same local weekday and wall-clock
time. Weekday meetings repeat Monday through Friday and must start on a weekday.
Duration and nudge offsets are elapsed minutes.

A first start in a nonexistent local time is rejected. A later occurrence in a
DST gap is skipped. An ambiguous local start uses the earlier UTC instant,
producing one meeting rather than two. Cancelled series generate no occurrences.
Occurrence previews accept an inclusive UTC lower bound and a limit from 1 to
32; lookahead is bounded to three years.

## CLI

```bash
buzz meetings create --channel "$CHANNEL_ID" \
  --title "Weekly team sync" \
  --starts-at 2026-10-26T10:00:00 \
  --timezone Europe/Berlin --duration 30 --repeat weekly

buzz meetings list --channel "$CHANNEL_ID"
buzz meetings get --channel "$CHANNEL_ID" --meeting "$MEETING_ID"
buzz meetings occurrences --channel "$CHANNEL_ID" --meeting "$MEETING_ID" \
  --after 2026-10-25T00:00:00Z --limit 3
buzz meetings skip --channel "$CHANNEL_ID" --meeting "$MEETING_ID" \
  --date 2026-11-02

HEAD=$(buzz meetings get --channel "$CHANNEL_ID" --meeting "$MEETING_ID")
printf '%s\n' "$HEAD" | jq -r '.[0].content' | \
  jq '.title = "Weekly priorities"' | \
  buzz meetings update --channel "$CHANNEL_ID" --meeting "$MEETING_ID" \
    --expected-revision "$(printf '%s\n' "$HEAD" | jq -r '.[0].id')" \
    --definition -

buzz meetings cancel --channel "$CHANNEL_ID" --meeting "$MEETING_ID"
```

`get` and `occurrences` accept `--organizer <pubkey>` for another member's
meeting; the signer is the default. Event reads preserve the normal CLI format
contract and return arrays of signed events. `occurrences` returns an array of
derived UTC starts/ends and optional nudge instants. `list` includes cancelled
heads, defaults to 100 results, and accepts `--limit` up to 1000.

`update` accepts a complete definition as JSON or `-` for bounded stdin. The
required `--expected-revision` is the signed head ID observed before editing.
Stale updates exit with code 5. `skip` and `cancel` read the signer's current
head and publish guarded replacements. All three preserve existing nudge
metadata; the CLI and desktop do not enable or change nudges before delivery
exists.

## Validation

- Shared model and SDK unit tests cover validation, DST, and signed envelopes.
- `cargo test -p buzz-cli commands::meetings::tests` exercises the CLI's query
  and publish boundaries, including stale updates and bounded input.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib commands::meetings::tests`
  covers native scope and signature validation.
- `cd desktop && pnpm build:e2e && pnpm exec playwright test --project=smoke channel-meetings.spec.ts channel-meeting-timing.spec.ts`
  exercises the actual React UI through the mock Tauri bridge, including
  tab contrast, full-width gutters, timing boundaries, recurrence rollover,
  in-channel reminders, and explicit huddle start/join with retryable errors.
- Against an isolated local relay, run
  `cargo test -p buzz-test-client --test e2e_meetings -- --ignored`. It checks
  private-channel access, concurrent revisions, cancellation, and exact replay.
  Configure `RELAY_URL` for that relay; do not reset a shared development DB.

For native acceptance, use a real Tauri/WebKit app with the production frontend,
not the E2E mock bridge. In an isolated profile and temporary relay database,
exercise create, edit, skip, cancel, and app restart. Verify the persisted
revision after reopening. On Linux, inspect the actual dark-theme date and
select controls; Chromium screenshots do not prove WebKit's native painting.
Also exercise a currently running meeting, reschedule it outside and inside
the five-minute reminder window, and skip/cancel it. Messages must update
without creating audio. Explicitly start a huddle from the reminder in a private
fixture channel and verify it uses that channel, changes to Open huddle, and
can be left. Use a microphone-unavailable test boundary to avoid capturing
device audio during automation; this does not prove microphone hardware works.
Before a managed rollout, also test the installed app against its configured
relay with a temporary private channel and a unique meeting title. Cancel the
test series and archive the temporary channel afterward. Native automation does
not substitute for the human acceptance check.

## Remaining slices

- Channel-admin management of other organizers' series.
- Relay-side durable nudge scheduling with retry recovery, deduplication, and
  cancellation fencing against newer meeting heads.
