import type { CharmLinkState, CharmNetworkReport } from "@/lib/charm-protocol"

/**
 * The charm's own answer about its two links, in the states its wire names for each — one builder
 * for the words test and the settings row's test, so both draw the same report.
 */
export const report = (wifi: CharmLinkState, tailnet: CharmLinkState): CharmNetworkReport => ({
  wifi: { state: wifi, reason: 0, ip: "", ssid: "" },
  tailnet: { state: tailnet, ip: "" },
})
