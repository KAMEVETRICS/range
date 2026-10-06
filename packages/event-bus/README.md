# Event bus

`InMemoryEventBus` and `RedpandaEventBus` implement `EventBus`: keyed publish,
typed topic subscription, and an async unsubscribe function. Every send and
delivery is validated with a topic schema derived from `@range/domain`.

```ts
const bus = new RedpandaEventBus({ clientId: "range-normalizer", brokers: ["localhost:19092"] });
const stop = await bus.subscribe("market.observation.v1", "normalizer-v1", async event => {
  // Use event.eventId for idempotency. Source/receive timestamps are epoch ms.
});
// On application shutdown:
await stop();
await bus.close();
```

Use one stable venue/instrument key for a feed. New groups replay from the
beginning; existing groups resume committed offsets. A consumer that replays a
topic under a fresh group on every start should pass `{ deleteGroupOnStop: true }`,
so each stop deletes its group; a group left by a crash expires with Redpanda's
offset retention (`group_offset_retention_sec`, 7 days). Redpanda delivery is at
least once, with commits after successful handling. A crash between a side effect
and its commit can redeliver an event; handlers must be idempotent. Handler errors
are retried by KafkaJS and do not enter the dead-letter topic. KafkaJS consumers
must process each event within the configured session timeout.

Invalid JSON/schema messages are written to `range.dead-letter.v1` before the
source offset advances. Invalid publications reject with `InvalidEventError`
after quarantine. Dead letters contain routing metadata, a SHA-256 payload hash,
a fixed error code, and a UUID trace ID; raw payloads and validation issues are
never copied. Routing keys must be identifiers, never credentials. An invalid
dead-letter message fails consumption without recursive quarantine.

`market.raw.v1` carries observation metadata and `rawPayloadRefOrHash`, without
a parsed payload. Connectors publish it only when `RANGE_PUBLISH_RAW_EVENTS=true`:
nothing reads it until the raw archive exists. Raw bytes stay in object storage. Book and funding topics use
the canonical observation envelope with their respective payload schemas. Health,
opportunity, evidence, and intent topics reuse their canonical domain objects;
`intent.lifecycle.v1` currently carries the unsigned intent domain contract.

The in-memory log retains records for its lifetime and validates independent
copies on delivery. Publish waits for active handlers. Failed handlers retry on
the next publish or subscription. Do not await publication to the same topic
from its own handler; use Redpanda for asynchronous pipelines and durable storage.

Local infrastructure: `docker compose -f infra/compose.yaml up -d --wait` from
the repository root. Containers connect to `redpanda:9092`. Code on the host
connects to `localhost:19092` once `-f infra/compose.dev.yaml` publishes it;
`compose.yaml` alone publishes no broker port. The Compose services use public local-only credentials and
named volumes. They are a development reference, not a production deployment.

Run `pnpm vitest packages/event-bus --run` with Docker running. The integration
test starts a real three-partition Redpanda topic, publishes a keyed pair,
restarts the consumer using a new group, asserts replay order, and checks broker
side invalid-message quarantine. It deliberately fails when Docker is unavailable.
