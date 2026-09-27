import type { Opportunity, OpportunityDetailEnvelope } from "../api/client.js";

export function EvidencePanel({ opportunity, detail }: { opportunity: Opportunity; detail?: OpportunityDetailEnvelope }) {
  return (
    <section className="evidence-panel" aria-labelledby="evidence-heading">
      <div className="section-heading compact"><div><p className="eyebrow">Lineage</p><h3 id="evidence-heading">Evidence</h3></div><span className="revision">Revision {opportunity.stateRevision}</span></div>
      <dl className="evidence-list">
        <div><dt>Evidence hash</dt><dd className="hash">{opportunity.evidenceHash ?? "Not available"}</dd></div>
        <div><dt>Source events</dt><dd>{detail?.evidence.length ? detail.evidence.map((item) => item.event_id).join(", ") : "Available after inspection"}</dd></div>
        <div><dt>Server as of</dt><dd>{detail ? new Date(detail.as_of).toLocaleString() : "Loading current detail…"}</dd></div>
        <div><dt>Trace</dt><dd className="hash">{detail?.trace_id ?? "Pending"}</dd></div>
      </dl>
      {detail?.warnings.length ? <div className="inline-warning"><strong>Evidence warnings</strong><p>{detail.warnings.join(" · ")}</p></div> : null}
    </section>
  );
}
