import type { DashboardStreamEvent, Envelope, OpportunityDetailEnvelope, VenueView } from "./client.js";

interface SubscribeOptions {
  url: string;
  headers: HeadersInit;
  handler(event: DashboardStreamEvent): void | Promise<void>;
  retryMs?: number;
}

interface ParsedEvent { id?: string; event?: string; data?: string }

function parseFrame(frame: string): ParsedEvent {
  const parsed: ParsedEvent = {};
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
    else if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length) parsed.data = data.join("\n");
  return parsed;
}

function toDashboardEvent(event: ParsedEvent): DashboardStreamEvent | undefined {
  if (!event.event || !event.data) return undefined;
  const body = JSON.parse(event.data) as Envelope<unknown>;
  if (event.event === "opportunity") {
    const result = body.result as { opportunity?: unknown; opportunity_id?: string; current?: boolean };
    if (result.current === false && result.opportunity_id) {
      return { kind: "invalidation", opportunityId: result.opportunity_id, message: "Opportunity invalidated by live update." };
    }
    if (result.opportunity) return { kind: "opportunity", detail: body as OpportunityDetailEnvelope, message: "Opportunity updated from the live stream." };
  }
  if (event.event === "health") {
    const venue = body.result as VenueView;
    return { kind: "health", venue, message: `${venue.venue} health changed to ${venue.health?.connectionState ?? "missing"}.` };
  }
  return undefined;
}

export function subscribeToRangeStream(options: SubscribeOptions): () => void {
  const controller = new AbortController();
  let lastEventId: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const retryMs = options.retryMs ?? 1500;

  const connect = async () => {
    if (controller.signal.aborted) return;
    try {
      const requestHeaders = new Headers(options.headers);
      requestHeaders.set("Accept", "text/event-stream");
      if (lastEventId) requestHeaders.set("Last-Event-ID", lastEventId);
      const response = await fetch(options.url, { headers: requestHeaders, signal: controller.signal, credentials: "same-origin" });
      if (!response.ok || !response.body) throw new Error("STREAM_UNAVAILABLE");
      await options.handler({ kind: "connection", state: "connected", message: "Live updates connected." });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = parseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (frame.id) lastEventId = frame.id;
          const update = toDashboardEvent(frame);
          if (update) await options.handler(update);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    }
    if (!controller.signal.aborted) {
      await options.handler({ kind: "connection", state: "reconnecting", message: "Live updates interrupted; reconnecting with the last event ID." });
      reconnectTimer = setTimeout(() => void connect(), retryMs);
    }
  };

  void connect();
  return () => {
    controller.abort();
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}
