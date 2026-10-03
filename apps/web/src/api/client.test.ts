import { afterEach, expect, it, vi } from "vitest";
import { createDashboardApi } from "./client.js";

afterEach(() => { vi.unstubAllGlobals(); });

it("marks every API call as the dashboard's, so the public proxy reads it with the dashboard's own budget", async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ result: { items: [], next_offset: null } }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);

  await createDashboardApi().listVenues();
  await createDashboardApi({ readToken: "local_read_token_".padEnd(40, "0") }).listVenues();

  const [first, second] = fetch.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers));
  expect(first!.get("X-Range-Client")).toBe("dashboard");
  expect(first!.has("Authorization")).toBe(false);
  expect(second!.get("X-Range-Client")).toBe("dashboard");
  expect(second!.get("Authorization")).toBe(`Bearer ${"local_read_token_".padEnd(40, "0")}`);
});
