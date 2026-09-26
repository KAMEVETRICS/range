import { FundingCompareQuerySchema, responseSchemas } from "@range/application";
import type { RouteDefinition } from "./types.js";

export const fundingRoute: RouteDefinition = { path: "/v1/funding/compare", operationId: "compareFunding", scope: "market:read",
  query: FundingCompareQuerySchema, response: responseSchemas.funding,
  execute: (app, input, context) => app.compareFunding(input, context) };
