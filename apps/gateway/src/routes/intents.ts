import { CreateIntentRequestSchema, EmptyIntentRequestSchema, IntentParamsSchema, OpportunityParamsSchema, intentResponseSchemas } from "@range/application";
export const intentRoutes = [
  { path: "/v1/opportunities/:id/intent", operationId: "createUnsignedIntent", scope: "intent:create" as const,
    body: CreateIntentRequestSchema.omit({ opportunityId: true, idempotencyKey: true }), params: OpportunityParamsSchema,
    idempotencyKey: CreateIntentRequestSchema.shape.idempotencyKey, response: intentResponseSchemas.create },
  { path: "/v1/intents/:id/validate", operationId: "validateUnsignedIntent", scope: "intent:create" as const, body: EmptyIntentRequestSchema, params: IntentParamsSchema, response: intentResponseSchemas.validate },
];
