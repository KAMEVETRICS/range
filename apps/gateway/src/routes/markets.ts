import { MarketQuerySchema, responseSchemas } from "@range/application";
import type { RouteDefinition } from "./types.js";
export const marketsRoute: RouteDefinition = { path: "/v1/markets/snapshot", operationId: "getMarketSnapshot", scope: "market:read", query: MarketQuerySchema,
  response: responseSchemas.markets, execute: (app, input, context) => app.getMarketSnapshot(input, context) };
