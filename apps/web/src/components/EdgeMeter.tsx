/** The net edge, in bps, at which the meter's bar reaches either end. */
const SCALE_BPS = 30;

/**
 * Where a net edge sits against break-even: the bar grows right of the center line when the edge clears every cost and
 * left of it when it falls short, so a column of them shows at a glance how far each pair is from actionable. The
 * number itself is always shown beside it, so the meter is decorative.
 */
export function EdgeMeter({ netEdgeBps }: { netEdgeBps: string }) {
  const value = Number(netEdgeBps);
  const share = Number.isFinite(value) ? Math.min(Math.abs(value), SCALE_BPS) / SCALE_BPS * 50 : 0;
  return (
    <span className="edge-meter" aria-hidden="true">
      {share > 0 && <span className={value >= 0 ? "pos" : "neg"} style={{ width: `${share}%` }} />}
    </span>
  );
}
