import { runConnectorService } from "@range/connector-sdk";
import { createBitgetAdapter } from "./adapter.js";
import { BitgetPublicClient, createBitgetPublicWebSocket } from "./client.js";

runConnectorService(createBitgetAdapter(new BitgetPublicClient(), createBitgetPublicWebSocket()))
  .catch(() => { console.error("Bitget read-only connector startup failed."); process.exitCode = 1; });
