import { InstrumentQuerySchema, responseSchemas } from "@range/application";
import type { RouteDefinition } from "./types.js";
export const instrumentsRoute: RouteDefinition = { path: "/v1/instruments", operationId: "findInstruments", scope: "market:read", query: InstrumentQuerySchema,
  response: responseSchemas.instruments, execute: (app, input, context) => app.findInstruments(input, context) };
