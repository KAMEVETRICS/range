import { runConnectorService } from "@range/connector-sdk";
import { createBinanceAdapter } from "@range/connector-aster";

// Binance futures shares its API with Aster, whose connector reads both.
runConnectorService(createBinanceAdapter())
  .catch(() => { console.error("Binance read-only connector startup failed."); process.exitCode = 1; });
