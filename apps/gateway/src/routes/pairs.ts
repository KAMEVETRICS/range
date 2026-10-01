import { PairsQuerySchema, responseSchemas } from "@range/application";
import type { RouteDefinition } from "./types.js";
export const pairsRoute: RouteDefinition = { path: "/v1/pairs", operationId: "getPairEvaluations", scope: "opportunity:read",
  query: PairsQuerySchema, response: responseSchemas.pairs, execute: (app, input, context) => app.getPairEvaluations(input, context) };
