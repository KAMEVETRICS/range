import type { VenueView } from "../api/client.js";
import { HEALTH_TONE, VenueIcon, healthLabel, venueInfo } from "../venues.js";

function describe(venue: VenueView): string {
  const accepted = venue.asOfMs === null ? "accepted time unavailable" : `accepted ${new Date(venue.asOfMs).toISOString()}`;
  if (!venue.health) return `No current health record · ${accepted}`;
  return `Last event ${(venue.health.lastEventAgeMs / 1000).toFixed(1)} s ago · sequence ${venue.health.sequenceIntegrity} · rate limit ${venue.health.rateLimit.state} · ${accepted}`;
}

export function VenueHealth({ venues, warnings }: { venues: VenueView[]; warnings: string[] }) {
  return (
    <section className="venue-strip" aria-label="Venue health">
      <div className="strip-head">
        <h2>Venue health</h2>
      </div>
      <ul className="venue-chips">
        {venues.map((venue) => {
          const label = healthLabel(venue);
          return (
            <li key={venue.venue} className="venue-chip" title={describe(venue)}>
              <VenueIcon venue={venue.venue} />
              <span className="venue-name">{venueInfo(venue.venue).label}</span>
              <span className={`status ${HEALTH_TONE[label]}`}><span className="status-text">{label}</span></span>
              <span className="venue-age">{venue.health ? `${(venue.health.lastEventAgeMs / 1000).toFixed(1)} s` : "—"}</span>
            </li>
          );
        })}
      </ul>
      {warnings.length > 0 && <p className="strip-warning">{warnings.join(" · ")}</p>}
    </section>
  );
}
