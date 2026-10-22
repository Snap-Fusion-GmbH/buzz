import type { QueryClient } from "@tanstack/react-query";

import type { RelayEvent } from "@/shared/api/types";
import { relayClient } from "@/shared/api/relayClient";
import { KIND_REACTION } from "@/shared/constants/kinds";
import {
  channelMessagesKey,
  channelWindowKey,
  sortMessages,
} from "./messageQueryKeys";
import {
  mergeLiveChannelWindowEvent,
  type ChannelWindowStore,
} from "./channelWindowStore";
import { projectChannelWindowMessages } from "./projectChannelWindow";

/** Recover a duplicate add only after reading the caller's existing reaction. */
export async function recoverDuplicateReaction(
  queryClient: QueryClient,
  eventId: string,
  emoji: string,
  publicKey: string,
  rejection: unknown,
  isCurrent: () => boolean,
): Promise<void> {
  if (
    !(rejection instanceof Error) ||
    ![
      "duplicate: reaction already exists",
      "relay rejected event: duplicate: reaction already exists",
    ].includes(rejection.message) ||
    !isCurrent()
  ) {
    throw rejection;
  }
  const events = await relayClient.fetchEvents({
    kinds: [KIND_REACTION],
    authors: [publicKey],
    "#e": [eventId],
    limit: 500,
  });
  const reaction = events.find(
    (event) =>
      event.kind === KIND_REACTION &&
      event.pubkey === publicKey &&
      (event.content || "+").trim() === emoji.trim() &&
      event.tags.filter((tag) => tag[0] === "e").at(-1)?.[1] === eventId,
  );
  if (!reaction || !isCurrent()) throw rejection;

  for (const prefix of ["channel-messages", "thread-replies"]) {
    for (const [key, messages] of queryClient.getQueriesData<RelayEvent[]>({
      queryKey: [prefix],
    })) {
      if (!messages?.some((event) => event.id === eventId)) continue;
      if (prefix === "channel-messages" && typeof key[1] === "string") {
        const channelId = key[1];
        const windowKey = channelWindowKey(channelId);
        const window = queryClient.getQueryData<ChannelWindowStore>(windowKey);
        if (window) {
          queryClient.setQueryData(
            windowKey,
            mergeLiveChannelWindowEvent(window, reaction, false),
          );
          projectChannelWindowMessages(queryClient, channelId);
          continue;
        }
        queryClient.setQueryData(
          channelMessagesKey(channelId),
          sortMessages([...messages, reaction]),
        );
      } else {
        queryClient.setQueryData(key, sortMessages([...messages, reaction]));
      }
    }
  }
}
