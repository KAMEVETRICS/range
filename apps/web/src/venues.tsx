import type { VenueView } from "./api/client.js";

/** Bitget is the primary venue: Markets compares every other venue with it. */
export const PRIMARY_VENUE = "bitget";

/** How each venue is used: reviewed pairs trade on two; the rest are reference data or the Markets board only. */
export type VenueRole = "executable" | "reference" | "board";

export const VENUES: Record<string, { label: string; mono: string; role: VenueRole }> = {
  bitget: { label: "Bitget", mono: "BG", role: "executable" },
  hyperliquid_hip3: { label: "Hyperliquid", mono: "HL", role: "executable" },
  extended: { label: "Extended", mono: "EX", role: "reference" },
  ondo_perps: { label: "Ondo", mono: "ON", role: "reference" },
  binance: { label: "Binance", mono: "BN", role: "board" },
  bybit: { label: "Bybit", mono: "BY", role: "board" },
  aster: { label: "Aster", mono: "AS", role: "board" },
  lighter: { label: "Lighter", mono: "LI", role: "board" },
  qfex: { label: "QFEX", mono: "QF", role: "board" },
  nado: { label: "Nado", mono: "NA", role: "board" },
  pacifica: { label: "Pacifica", mono: "PA", role: "board" },
  variational: { label: "Variational", mono: "VA", role: "board" },
};

export const venueInfo = (venue: string) =>
  VENUES[venue] ?? { label: venue.replaceAll("_", " "), mono: venue.slice(0, 2).toUpperCase(), role: "board" as VenueRole };

export type HealthLabel = "Healthy" | "Degraded" | "Excluded" | "Missing";

export function healthLabel(venue: VenueView): HealthLabel {
  if (!venue.health) return "Missing";
  const healthy = venue.health.connectionState === "connected" && venue.health.sequenceIntegrity === "consistent" &&
    venue.health.rateLimit.state === "healthy";
  return healthy ? "Healthy" : venue.health.connectionState === "quarantined" ? "Excluded" : "Degraded";
}

/** A status chip's tone for each health label. */
export const HEALTH_TONE: Record<HealthLabel, "ok" | "warn" | "bad"> = { Healthy: "ok", Degraded: "warn", Excluded: "bad", Missing: "bad" };

export const VenueIcon = ({ venue }: { venue: string }) =>
  <span className="venue-icon" data-venue={venue} data-mono={venueInfo(venue).mono} aria-hidden="true" />;
