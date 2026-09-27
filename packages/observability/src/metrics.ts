export const RANGE_METRICS = [
  "range_connector_lag_ms", "range_connector_reconnects_total", "range_book_sequence_gaps_total",
  "range_clock_skew_ms", "range_stale_rejections_total", "range_opportunity_age_ms",
  "range_intent_expiry_total", "range_gateway_latency_ms", "range_event_lag_ms", "range_replay_drift_total",
] as const;

export type RangeMetricName = (typeof RANGE_METRICS)[number];
export type MetricLabels = Readonly<Record<string, string>>;

type Metric = { name: RangeMetricName; labels: MetricLabels; value: number; count: number; sum: number };
const keyOf = (name: string, labels: MetricLabels) => `${name}|${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",")}`;

export class MetricRegistry {
  private readonly values = new Map<string, Metric>();

  increment(name: RangeMetricName, labels: MetricLabels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Metric increment must be finite and non-negative");
    const metric = this.get(name, labels);
    metric.value += amount;
    metric.count += 1;
    metric.sum += amount;
  }

  set(name: RangeMetricName, value: number, labels: MetricLabels = {}): void {
    if (!Number.isFinite(value) || value < 0) throw new Error("Metric value must be finite and non-negative");
    const metric = this.get(name, labels);
    metric.value = value;
    metric.count += 1;
    metric.sum += value;
  }

  observe(name: RangeMetricName, value: number, labels: MetricLabels = {}): void { this.set(name, value, labels); }

  value(name: RangeMetricName, labels: MetricLabels = {}): number { return this.values.get(keyOf(name, labels))?.value ?? 0; }

  snapshot(): Metric[] { return [...this.values.values()].map(metric => ({ ...metric, labels: { ...metric.labels } })); }

  prometheus(): string {
    return this.snapshot().sort((a, b) => keyOf(a.name, a.labels).localeCompare(keyOf(b.name, b.labels))).map(metric => {
      const labels = Object.entries(metric.labels).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`).join(",");
      return `${metric.name}${labels ? `{${labels}}` : ""} ${metric.value}`;
    }).join("\n") + "\n";
  }

  private get(name: RangeMetricName, labels: MetricLabels): Metric {
    const key = keyOf(name, labels);
    let metric = this.values.get(key);
    if (!metric) { metric = { name, labels: { ...labels }, value: 0, count: 0, sum: 0 }; this.values.set(key, metric); }
    return metric;
  }
}
