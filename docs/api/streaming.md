# Streaming

`GET /v1/stream` sends Server-Sent Events as results and venue health change.

```bash
curl -N "https://range.datatides.xyz/v1/stream?underlying=equity:NVDA"
```

| Parameter | |
| --- | --- |
| `underlying` | Optional; only events for this stock |
| `Last-Event-ID` header | Resume after this event |

## Events

| Event | Data |
| --- | --- |
| `opportunity` | Either a current result, as the envelope [inspecting it](endpoints.md#inspect-an-opportunity) would return, or an invalidation: an envelope whose `result` is `{"opportunity_id": "...", "current": false}`, sent when a result was replaced or expired |
| `health` | An envelope with one venue's health, as in [`/v1/venues`](endpoints.md#venues) |

Each event's `id` is `evt_` followed by a durable sequence number. A comment line arrives every 15 seconds as a heartbeat.

## Resuming

Reconnect with the last `id` you received in the `Last-Event-ID` header, and the stream resumes strictly after it. Without one, it starts at the current tail. Before replaying a result, the stream checks it is still current and sends an invalidation if it is not.

A client that reads too slowly is disconnected once its queue fills. Reconnect with the last id. The server holds at most 100 streams at once (`STREAM_CAPACITY`).

## In a browser

The public stream needs no headers, so `EventSource` works directly:

```js
const stream = new EventSource("https://range.datatides.xyz/v1/stream?underlying=equity:NVDA");
stream.addEventListener("opportunity", event => console.log(JSON.parse(event.data)));
stream.addEventListener("health", event => console.log(JSON.parse(event.data)));
```

`EventSource` reconnects on its own and sends `Last-Event-ID` for you.
