import { runConnectorService } from "@range/connector-sdk";
import { createOndoPerpsAdapter } from "./adapter.js";
import { OndoPerpsPublicClient } from "./client.js";

runConnectorService(createOndoPerpsAdapter(new OndoPerpsPublicClient()))
  .catch(() => { console.error("Ondo Perps read-only connector startup failed."); process.exitCode = 1; });
