import type { MeetingDefinition } from "@/shared/api/meetingTypes";
import { Input } from "@/shared/ui/input";
import { ChevronDown } from "lucide-react";
import type { LabelHTMLAttributes } from "react";

function Label({ htmlFor, children }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className="text-sm font-medium" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

type Props = {
  definition: MeetingDefinition;
  disabled: boolean;
  id: string;
  onChange: (definition: MeetingDefinition) => void;
};

const SELECT_CLASS =
  "h-9 w-full appearance-none rounded-lg border border-input/40 bg-background py-1 pl-3 pr-9 text-base text-foreground transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

function SelectIndicator() {
  return (
    <ChevronDown
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
    />
  );
}

/** The native meeting schedule fields, without a location or preparation note. */
export function MeetingFormFields({
  definition,
  disabled,
  id,
  onChange,
}: Props) {
  const update = (value: Partial<MeetingDefinition>) =>
    onChange({ ...definition, ...value });
  const durations = Array.from(
    new Set([15, 30, 45, 60, definition.duration_minutes]),
  ).sort((left, right) => left - right);
  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">Meeting schedule</legend>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-name`}>Meeting name</Label>
        <Input
          autoFocus
          id={`${id}-name`}
          maxLength={256}
          onChange={(event) => update({ title: event.target.value })}
          placeholder="e.g. Weekly team sync"
          required
          value={definition.title}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-date`}>First meeting</Label>
          <Input
            id={`${id}-date`}
            onChange={(event) =>
              update({
                starts_at: `${event.target.value}T${definition.starts_at.slice(11, 16)}:00`,
              })
            }
            required
            type="date"
            value={definition.starts_at.slice(0, 10)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-time`}>Start time</Label>
          <Input
            id={`${id}-time`}
            onChange={(event) =>
              update({
                starts_at: `${definition.starts_at.slice(0, 10)}T${event.target.value}:00`,
              })
            }
            required
            step={60}
            type="time"
            value={definition.starts_at.slice(11, 16)}
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-duration`}>Duration</Label>
          <div className="relative">
            <select
              className={SELECT_CLASS}
              id={`${id}-duration`}
              onChange={(event) =>
                update({ duration_minutes: Number(event.target.value) })
              }
              value={definition.duration_minutes}
            >
              {durations.map((duration) => (
                <option key={duration} value={duration}>
                  {duration} minutes
                </option>
              ))}
            </select>
            <SelectIndicator />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-repeat`}>Repeats</Label>
          <div className="relative">
            <select
              className={SELECT_CLASS}
              id={`${id}-repeat`}
              onChange={(event) =>
                update({
                  recurrence: event.target
                    .value as MeetingDefinition["recurrence"],
                })
              }
              value={definition.recurrence}
            >
              <option value="once">Does not repeat</option>
              <option value="weekly">Every week</option>
              <option value="fortnightly">Every two weeks</option>
              <option value="weekdays">Every weekday</option>
            </select>
            <SelectIndicator />
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-timezone`}>Meeting timezone</Label>
        <Input
          autoComplete="off"
          id={`${id}-timezone`}
          maxLength={128}
          list={`${id}-timezones`}
          onChange={(event) => update({ timezone: event.target.value })}
          placeholder="Europe/Berlin"
          required
          value={definition.timezone}
        />
        <datalist id={`${id}-timezones`}>
          {[
            "Europe/Berlin",
            "UTC",
            "America/New_York",
            "America/Los_Angeles",
          ].map((timezone) => (
            <option key={timezone} value={timezone} />
          ))}
        </datalist>
        <p className="text-xs text-muted-foreground">
          Repeats keep this local time across daylight-saving changes.
        </p>
      </div>
    </fieldset>
  );
}
