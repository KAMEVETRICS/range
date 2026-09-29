import { MarketOverviewQuerySchema, MarketQuerySchema, responseSchemas } from "@range/application";
import type { RouteDefinition } from "./types.js";
export const marketsRoute: RouteDefinition = { path: "/v1/markets/snapshot", operationId: "getMarketSnapshot", scope: "market:read", query: MarketQuerySchema,
  response: responseSchemas.markets, execute: (app, input, context) => app.getMarketSnapshot(input, context) };
export const marketOverviewRoute: RouteDefinition = { path: "/v1/markets/overview", operationId: "getMarketOverview", scope: "market:read",
  query: MarketOverviewQuerySchema, response: responseSchemas.marketOverview, execute: (app, input, context) => app.getMarketOverview(input, context) };
