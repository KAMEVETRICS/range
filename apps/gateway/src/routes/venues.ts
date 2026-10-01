import { PageQuerySchema, responseSchemas } from "@range/application";
import type { RouteDefinition } from "./types.js";
export const venuesRoute: RouteDefinition = { path: "/v1/venues", operationId: "listVenues", scope: "market:read", query: PageQuerySchema,
  response: responseSchemas.venues, execute: (app, input, context) => app.listVenues(input, context) };
