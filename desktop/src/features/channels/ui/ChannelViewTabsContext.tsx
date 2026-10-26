import { createContext, useContext, type ReactNode } from "react";

const ChannelViewTabsContext = createContext<ReactNode>(null);

/** Supply persistent view navigation inside the channel's measured chrome. */
export const ChannelViewTabsProvider = ChannelViewTabsContext.Provider;

/** Read optional navigation without changing non-meeting channel headers. */
export function useChannelViewTabs() {
  return useContext(ChannelViewTabsContext);
}
