import { runConnectorService } from "@range/connector-sdk";
import { createExtendedAdapter } from "./adapter.js";
import { createExtendedPublicWebSocket, ExtendedReadonlyClient } from "./client.js";

runConnectorService(createExtendedAdapter(new ExtendedReadonlyClient(), createExtendedPublicWebSocket(), process.env.EXTENDED_API_KEY))
  .catch(() => { console.error("Extended read-only connector startup failed."); process.exitCode = 1; });
