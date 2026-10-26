import assert from "node:assert/strict";
import test from "node:test";
import {
  compatibleMeetingDefinition,
  formatMeetingTime,
  formatMeetingRange,
  meetingTiming,
  meetingsNeedingAttention,
  nextMeetingOccurrence,
  meetingRecurrenceLabel,
  meetingsQueryKey,
  newMeetingDefinition,
  upcomingMeetingSeries,
} from "./meetingPresentation.ts";

test("anchor edits remove obsolete exclusions without reviving compatible skipped dates", () => {
  const definition = {
    ...newMeetingDefinition(new Date("2026-10-25T00:00:00Z"), "UTC"),
    starts_at: "2026-11-02T10:00:00",
    skipped_dates: ["2026-10-26", "2026-11-02", "2026-11-09"],
  };
  assert.deepEqual(compatibleMeetingDefinition(definition).skipped_dates, [
    "2026-11-02",
    "2026-11-09",
  ]);
  assert.deepEqual(
    compatibleMeetingDefinition({
      ...definition,
      recurrence: "fortnightly",
    }).skipped_dates,
    ["2026-11-02"],
  );
  assert.deepEqual(
    compatibleMeetingDefinition({ ...definition, recurrence: "once" })
      .skipped_dates,
    ["2026-11-02"],
  );
  assert.deepEqual(
    compatibleMeetingDefinition({
      ...definition,
      recurrence: "weekdays",
      skipped_dates: ["2026-11-02", "2026-11-07", "2026-11-09"],
    }).skipped_dates,
    ["2026-11-02", "2026-11-09"],
  );
  const incomplete = { ...definition, starts_at: "T10:00:00" };
  assert.equal(compatibleMeetingDefinition(incomplete), incomplete);
  assert.equal(definition.skipped_dates.length, 3);
});

test("new meetings use the next calendar date in the requested timezone", () => {
  const beforeDst = newMeetingDefinition(
    new Date("2026-10-24T22:30:00Z"),
    "Europe/Berlin",
  );
  assert.equal(beforeDst.starts_at, "2026-10-26T09:00:00");
  assert.equal(beforeDst.timezone, "Europe/Berlin");
  assert.equal(beforeDst.nudge_minutes_before, undefined);
  assert.equal("location" in beforeDst, false);
  assert.equal("preparation_note" in beforeDst, false);
  assert.equal(
    newMeetingDefinition(new Date("2026-12-31T23:30:00Z"), "Europe/Berlin")
      .starts_at,
    "2027-01-02T09:00:00",
  );
});

test("meeting cache keys isolate relays, identities, and channels", () => {
  const scope = {
    channelId: "channel-a",
    expectedRelayUrl: "wss://community-a.example",
    expectedSignerPubkey: "alice",
  };
  const original = meetingsQueryKey(scope);
  for (const [field, value] of [
    ["channelId", "channel-b"],
    ["expectedRelayUrl", "wss://community-b.example"],
    ["expectedSignerPubkey", "bob"],
  ]) {
    assert.notDeepEqual(
      meetingsQueryKey({ ...scope, [field]: value }),
      original,
    );
  }
});

test("active expired meetings remain editable instead of losing their recovery affordance", () => {
  const definition = newMeetingDefinition(
    new Date("2026-10-25T00:00:00Z"),
    "UTC",
  );
  const meeting = (id, starts, status = "active") => ({
    id,
    definition: { ...definition, title: id, status },
    occurrences: starts
      ? [
          {
            starts_at: starts,
            ends_at: new Date(Date.parse(starts) + 1_800_000).toISOString(),
          },
        ]
      : [],
  });
  const rows = [
    meeting("expired", null),
    meeting("later", "2026-11-02T09:00:00Z"),
    meeting("cancelled", "2026-10-26T08:00:00Z", "cancelled"),
    meeting("next", "2026-10-26T09:00:00Z"),
  ];
  assert.deepEqual(
    upcomingMeetingSeries(rows, Date.parse("2026-10-26T08:00:00Z")).map(
      (row) => row.id,
    ),
    ["next", "later", "expired"],
  );
  assert.equal(rows[0].id, "expired");
});

function timedMeeting(recurrence = "once") {
  return {
    id: "meeting",
    definition: {
      ...newMeetingDefinition(
        new Date("2026-10-25T00:00:00Z"),
        "Europe/Berlin",
      ),
      title: "Team sync",
      recurrence,
    },
    occurrences: [
      {
        local_date: "2026-10-26",
        starts_at: "2026-10-26T07:50:00Z",
        ends_at: "2026-10-26T08:20:00Z",
        nudge_at: null,
      },
    ],
  };
}

test("08:50–09:20 Berlin meeting is in progress at 08:51, not upcoming", () => {
  const meeting = timedMeeting();
  for (const [instant, phase, detail] of [
    ["2026-10-26T07:49:59Z", "upcoming", "Starts in 1 min"],
    ["2026-10-26T07:50:00Z", "in-progress", "30 min left"],
    ["2026-10-26T07:51:00Z", "in-progress", "29 min left"],
    ["2026-10-26T08:19:59Z", "in-progress", "1 min left"],
    ["2026-10-26T08:20:00Z", "ended", null],
  ]) {
    const timing = meetingTiming(meeting, Date.parse(instant));
    assert.equal(timing.phase, phase, instant);
    assert.equal(timing.detail, detail, instant);
  }
});

test("nudges include only live uncancelled occurrences within five minutes", () => {
  const meeting = timedMeeting();
  for (const [instant, count] of [
    ["2026-10-26T07:44:59Z", 0],
    ["2026-10-26T07:45:00Z", 1],
    ["2026-10-26T07:51:00Z", 1],
    ["2026-10-26T08:20:00Z", 0],
  ]) {
    assert.equal(
      meetingsNeedingAttention([meeting], Date.parse(instant)).length,
      count,
      instant,
    );
  }
  const now = Date.parse("2026-10-26T07:51:00Z");
  assert.deepEqual(
    meetingsNeedingAttention(
      [
        {
          ...meeting,
          definition: { ...meeting.definition, status: "cancelled" },
        },
      ],
      now,
    ),
    [],
  );
  assert.deepEqual(
    meetingsNeedingAttention([{ ...meeting, occurrences: [] }], now),
    [],
  );
});

test("cached recurrence rolls forward at the end without a network refresh", () => {
  const meeting = timedMeeting("weekly");
  const next = {
    local_date: "2026-11-02",
    starts_at: "2026-11-02T07:50:00Z",
    ends_at: "2026-11-02T08:20:00Z",
    nudge_at: null,
  };
  meeting.occurrences.push(next);
  const now = Date.parse("2026-10-26T08:20:00Z");
  assert.equal(nextMeetingOccurrence(meeting, now), next);
  assert.equal(meetingTiming(meeting, now).phase, "upcoming");
  assert.deepEqual(meetingsNeedingAttention([meeting], now), []);
});

test("ranges use 24-hour local time and retain overnight/DST end-date context", () => {
  const occurrence = timedMeeting().occurrences[0];
  const shown = formatMeetingRange(occurrence, "Europe/Berlin");
  assert.match(shown, /08:50/);
  assert.match(shown, /09:20/);
  assert.doesNotMatch(shown, /AM|PM/);
  const overnight = formatMeetingRange(
    {
      ...occurrence,
      starts_at: "2026-10-26T22:50:00Z",
      ends_at: "2026-10-26T23:20:00Z",
    },
    "Europe/Berlin",
  );
  assert.match(overnight, /26/);
  assert.match(overnight, /27/);
  assert.match(overnight, /23:50/);
  assert.match(overnight, /00:20/);
  const dst = formatMeetingRange(
    {
      ...occurrence,
      starts_at: "2026-10-25T00:30:00Z",
      ends_at: "2026-10-25T01:30:00Z",
    },
    "Europe/Berlin",
  );
  assert.match(dst, /GMT\+2|CEST/);
  assert.match(dst, /GMT\+1|CET/);
});

test("recurrence labels and explicit UTC fallback use the actual display helpers", () => {
  assert.equal(
    meetingRecurrenceLabel({ recurrence: "weekdays" }),
    "Monday–Friday",
  );
  assert.equal(
    meetingRecurrenceLabel({ recurrence: "fortnightly" }),
    "Every two weeks",
  );
  assert.equal(
    formatMeetingTime("2026-10-26T09:00:00Z", "Unsupported/Timezone"),
    "2026-10-26 09:00 UTC",
  );
});
