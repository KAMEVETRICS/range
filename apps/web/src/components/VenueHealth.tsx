import type { VenueView } from "../api/client.js";

function healthLabel(venue: VenueView) {
  if (!venue.health) return "Missing";
  const healthy = venue.health.connectionState === "connected" && venue.health.sequenceIntegrity === "consistent" && venue.health.rateLimit.state === "healthy";
  return healthy ? "Healthy" : venue.health.connectionState === "quarantined" ? "Excluded" : "Degraded";
}

export function VenueHealth({ venues, warnings }: { venues: VenueView[]; warnings: string[] }) {
  return (
    <section className="venue-strip" aria-label="Venue health">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Coverage</p>
          <h2>Venue health</h2>
        </div>
        <p className="coverage-note">Degraded, missing, stale, and reference-only sources are excluded from actionable results.</p>
      </div>
      <div className="venue-list">
        {venues.map((venue) => {
          const label = healthLabel(venue);
          return (
            <article className={`venue-item state-${label.toLowerCase()}`} key={venue.venue}>
              <div className="venue-title"><strong>{venue.venue.replaceAll("_", " ")}</strong><span className="status-label">{label}</span></div>
              <p>{venue.health ? `${(venue.health.lastEventAgeMs / 1000).toFixed(1)} s · sequence ${venue.health.sequenceIntegrity}` : "No current health record"}</p>
            </article>
          );
        })}
      </div>
      {warnings.length > 0 && <p className="venue-warning">{warnings.join(" · ")}</p>}
    </section>
  );
}
