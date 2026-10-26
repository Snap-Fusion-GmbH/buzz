import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useChannelsQuery } from "@/features/channels/hooks";
import { HomeScreen } from "@/features/home/ui/HomeScreen";
import { useIdentityQuery } from "@/shared/api/hooks";

type HomeRouteSearch = {
  item?: string;
  profile?: string;
  profileTab?: string;
  profileView?: string;
};

function validateHomeSearch(search: Record<string, unknown>): HomeRouteSearch {
  return {
    item:
      typeof search.item === "string" && search.item.length > 0
        ? search.item
        : undefined,
    profile:
      typeof search.profile === "string" && search.profile.length > 0
        ? search.profile
        : undefined,
    profileTab:
      typeof search.profileTab === "string" && search.profileTab.length > 0
        ? search.profileTab
        : undefined,
    profileView:
      typeof search.profileView === "string" && search.profileView.length > 0
        ? search.profileView
        : undefined,
  };
}

export const Route = createFileRoute("/")({
  validateSearch: validateHomeSearch,
  component: HomeRouteComponent,
});

function HomeRouteComponent() {
  const { goChannel } = useAppNavigation();
  const channelsQuery = useChannelsQuery();
  const identityQuery = useIdentityQuery();
  const availableChannelIds = React.useMemo(
    () => new Set((channelsQuery.data ?? []).map((channel) => channel.id)),
    [channelsQuery.data],
  );

  return (
    <HomeScreen
      availableChannelIds={availableChannelIds}
      currentPubkey={identityQuery.data?.pubkey}
      onOpenContext={(channelId, messageId, threadRootId) => {
        void goChannel(channelId, { messageId, threadRootId });
      }}
    />
  );
}
