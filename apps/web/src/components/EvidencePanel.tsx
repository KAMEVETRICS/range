import type { Opportunity, OpportunityDetailEnvelope } from "../api/client.js";

export function EvidencePanel({ opportunity, detail }: { opportunity: Opportunity; detail?: OpportunityDetailEnvelope }) {
  return (
    <section className="evidence-panel" aria-labelledby="evidence-heading">
      <div className="sub-head"><h3 id="evidence-heading">Evidence</h3><span>Revision {opportunity.stateRevision}</span></div>
      <dl className="evidence-list">
        <div><dt>Evidence hash</dt><dd className="hash">{opportunity.evidenceHash ?? "Not available"}</dd></div>
        <div><dt>Source events</dt><dd className="hash">{detail?.evidence.length ? detail.evidence.map((item) => item.event_id).join(", ") : "Available after inspection"}</dd></div>
        <div><dt>Envelope as of</dt><dd className="hash">{detail ? new Date(detail.as_of).toISOString() : "Loading current detail…"}</dd></div>
        <div><dt>Trace</dt><dd className="hash">{detail?.trace_id ?? "Pending"}</dd></div>
      </dl>
      {detail?.warnings.length ? <div className="notice warn"><strong>Evidence warnings</strong> {detail.warnings.join(" · ")}</div> : null}
    </section>
  );
}
