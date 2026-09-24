import type { z } from "zod";
import type { RangeApplication, RequestContext } from "@range/application";
import type { Scope } from "../auth.js";
export interface RouteDefinition {
  path: string; operationId: string; scope: Scope; query?: z.ZodType; params?: z.ZodType; response: z.ZodType;
  execute(application: RangeApplication, input: unknown, context: RequestContext): Promise<unknown>;
}
