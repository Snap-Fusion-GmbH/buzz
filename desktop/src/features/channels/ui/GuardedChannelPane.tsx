import * as React from "react";
import { CalendarDays, MessagesSquare } from "lucide-react";
import { allowNavigation } from "@/app/navigation/navigationGuard";
import { useCommunities } from "@/features/communities/useCommunities";
import { ChannelMeetingsPanel } from "@/features/meetings/ui/ChannelMeetingsPanel";
import { ChannelMeetingNudge } from "@/features/meetings/ui/ChannelMeetingNudge";
import type { MeetingScope } from "@/shared/api/meetingTypes";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { channelChrome } from "@/shared/layout/chromeLayout";
import { ChannelViewTabsProvider } from "./ChannelViewTabsContext";

import { ChannelPane } from "./ChannelScreenLazyViews";

export function GuardedChannelPane(
  props: React.ComponentProps<typeof ChannelPane>,
) {
  const { activeCommunity } = useCommunities();
  const channel = props.activeChannel;
  if (
    channel?.channelType !== "stream" ||
    props.isHuddleTranscript ||
    !props.currentPubkey ||
    !activeCommunity?.relayUrl
  ) {
    return <ChannelPane {...props} />;
  }
  const scope: MeetingScope = {
    channelId: channel.id,
    expectedRelayUrl: activeCommunity.relayUrl,
    expectedSignerPubkey: props.currentPubkey,
  };
  return <MeetingChannelPane paneProps={props} scope={scope} />;
}

function MeetingChannelPane({
  paneProps,
  scope,
}: {
  paneProps: React.ComponentProps<typeof ChannelPane>;
  scope: MeetingScope;
}) {
  const showTabs = !(
    paneProps.isSinglePanelView ||
    paneProps.channelManagementOpen ||
    paneProps.openThreadHeadId ||
    paneProps.openAgentSessionPubkey ||
    paneProps.profilePanelPubkey
  );
  const navigationTarget = JSON.stringify([
    scope.expectedRelayUrl,
    scope.expectedSignerPubkey,
    scope.channelId,
    paneProps.targetMessageId,
    paneProps.entranceMessageId,
    paneProps.openThreadHeadId,
    paneProps.autoSendDraftKey,
    paneProps.openAgentSessionPubkey,
    paneProps.profilePanelPubkey,
    paneProps.channelManagementOpen,
    paneProps.isSinglePanelView,
  ]);
  const [selection, setSelection] = React.useState({
    target: navigationTarget,
    view: "messages",
  });
  React.useEffect(() => {
    setSelection({ target: navigationTarget, view: "messages" });
  }, [navigationTarget]);
  const view =
    showTabs && selection.target === navigationTarget
      ? selection.view
      : "messages";
  const tabs = (
    <>
      <TabsList
        aria-label="Channel views"
        className="pointer-events-auto h-10 w-full shrink-0 justify-start gap-4 rounded-none border-b border-border bg-background px-5 py-0"
      >
        <TabsTrigger
          className="h-full gap-2 rounded-none border-b-2 border-transparent px-1 data-[state=active]:border-primary data-[state=active]:bg-muted data-[state=active]:shadow-none"
          value="messages"
        >
          <MessagesSquare aria-hidden="true" className="h-4 w-4" /> Messages
        </TabsTrigger>
        <TabsTrigger
          className="h-full gap-2 rounded-none border-b-2 border-transparent px-1 data-[state=active]:border-primary data-[state=active]:bg-muted data-[state=active]:shadow-none"
          value="meetings"
        >
          <CalendarDays aria-hidden="true" className="h-4 w-4" /> Meetings
        </TabsTrigger>
      </TabsList>
      {view === "messages" && paneProps.activeChannel ? (
        <ChannelMeetingNudge
          key={`${scope.expectedRelayUrl}:${scope.expectedSignerPubkey}:${scope.channelId}`}
          channel={paneProps.activeChannel}
          scope={scope}
          onOpenMeetings={() => {
            if (
              allowNavigation({
                kind: "route",
                href: `${window.location.pathname}#meetings`,
              })
            )
              setSelection({ target: navigationTarget, view: "meetings" });
          }}
        />
      ) : null}
    </>
  );
  return (
    <Tabs
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onValueChange={(next) => {
        if (
          allowNavigation({
            kind: "route",
            href: `${window.location.pathname}#${next}`,
          })
        )
          setSelection({ target: navigationTarget, view: next });
      }}
      value={view}
    >
      {showTabs ? (
        <ChannelViewTabsProvider value={tabs}>
          {paneProps.header}
        </ChannelViewTabsProvider>
      ) : null}
      {view === "meetings" ? (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 top-0 z-30 bg-background/90 backdrop-blur-md ${channelChrome.headerHeight}`}
        />
      ) : null}
      <TabsContent
        aria-label="Channel messages"
        aria-labelledby={undefined}
        className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
        role={showTabs ? "tabpanel" : "region"}
        value="messages"
      >
        <ChannelPane
          {...paneProps}
          header={showTabs ? undefined : paneProps.header}
        />
      </TabsContent>
      <TabsContent
        className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
        value="meetings"
      >
        {paneProps.activeChannel ? (
          <ChannelMeetingsPanel
            key={`${scope.expectedRelayUrl}:${scope.expectedSignerPubkey}:${scope.channelId}`}
            channel={paneProps.activeChannel}
            scope={scope}
          />
        ) : null}
      </TabsContent>
    </Tabs>
  );
}
