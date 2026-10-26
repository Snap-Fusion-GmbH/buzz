import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useHuddle } from "@/features/huddle";
import { HuddleIndicator } from "@/features/huddle/components/HuddleIndicator";
import { buildHuddleChannelName } from "@/features/huddle/lib/huddleChannelName";
import { formatHuddleActionError } from "@/features/huddle/lib/huddleError";
import type { Channel } from "@/shared/api/types";

/** Use the ordinary channel huddle, with explicit user consent and retry UI. */
export function MeetingHuddleAction({ channel }: { channel: Channel }) {
  const { startHuddle } = useHuddle();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function start() {
    setError(null);
    try {
      await startHuddle(channel.id, [], buildHuddleChannelName({ channel }));
      void queryClient.invalidateQueries({ queryKey: ["channels"] });
    } catch (failure) {
      if (alive.current) setError(formatHuddleActionError(failure, "start"));
    }
  }
  return (
    <div className="space-y-1" data-testid="meeting-huddle-action">
      <HuddleIndicator
        channelId={channel.id}
        enableShortcut={false}
        onStart={() => void start()}
        showLabel
        startDisabled={!channel.isMember || channel.archivedAt !== null}
      />
      {error ? (
        <p className="max-w-sm text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
