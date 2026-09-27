import { runConnectorService } from "@range/connector-sdk";
import { createHyperliquidAdapter } from "./adapter.js";
import { createHyperliquidPublicWebSocket, HyperliquidPublicClient } from "./client.js";

runConnectorService(createHyperliquidAdapter(new HyperliquidPublicClient(), createHyperliquidPublicWebSocket()))
  .catch(() => { console.error("Hyperliquid read-only connector startup failed."); process.exitCode = 1; });
