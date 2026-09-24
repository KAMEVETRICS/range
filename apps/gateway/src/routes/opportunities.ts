import { ScanQuerySchema, OpportunityParamsSchema, responseSchemas } from "@range/application";
import type { RouteDefinition } from "./types.js";
export const opportunitiesRoute: RouteDefinition = { path: "/v1/opportunities", operationId: "scanOpportunities", scope: "opportunity:read", query: ScanQuerySchema,
  response: responseSchemas.opportunities, execute: (app, input, context) => app.scanOpportunities(input, context) };
export const opportunityRoute: RouteDefinition = { path: "/v1/opportunities/:id", operationId: "inspectOpportunity", scope: "opportunity:read", params: OpportunityParamsSchema,
  response: responseSchemas.opportunity, execute: (app, input, context) => app.inspectOpportunity(input, context) };
