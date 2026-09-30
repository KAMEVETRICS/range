import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { ConnectorDiagnosticError } from "../../../packages/connector-sdk/src/index.js";
import { createPacificaVenue } from "./adapter.js";

const fixture = (name: string) => JSON.parse(readFileSync(
  new URL(`../../../tests/contracts/fixtures/pacifica/${name}.json`, import.meta.url),
  "utf8",
));

it("reads each listed market's book, skipping one that fails, and stops on a rate limit", async () => {
  const signal = new AbortController().signal;
  const books = vi.fn(async (query: Record<string, string>) => {
    if (query.symbol === "TSLA") return fixture("book-tsla");
    throw new ConnectorDiagnosticError("ADAPTER_FAILURE");
  });
  const venue = createPacificaVenue({ get: async (path, query) => path === "/api/v1/info" ? fixture("info") : books(query) });
  const instruments = await venue.discover(signal);

  const tops = await venue.tops(instruments, signal);
  expect([...tops.keys()]).toEqual(["TSLA"]);
  expect(books.mock.calls.map(call => call[0].symbol).sort()).toEqual(["NVDA", "TSLA"]);

  const limited = createPacificaVenue({ get: async () => { throw new ConnectorDiagnosticError("RATE_LIMITED", 5_000); } });
  await expect(limited.tops(instruments, signal)).rejects.toMatchObject({ code: "RATE_LIMITED" });
});
