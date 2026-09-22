# Bitget fixture provenance

These are sanitized, synthetic contract cases shaped from official Bitget V3 documentation, **not captured live responses**. Instrument identities and economic values exercise explicit RWA/Reality evidence, lookalike rejection, decimal funding, and millisecond timestamps. They do not assert current listings or prices.

Live capture was attempted on 2026-09-22 against the public instruments endpoint without authentication. Both the sandbox attempt and the approved network retry failed DNS resolution (`No such host is known`). Live REST/WS confirmation remains deferred.

Official schemas checked during implementation:

- https://www.bitget.com/docs/catalog/market-market-data/market-instruments
- https://www.bitget.com/docs/catalog/market-market-data/market-ticker
- https://www.bitget.com/docs/catalog/market-market-data/market-orderbook
- https://www.bitget.com/docs/uta/websocket/public/Order-Book-Channel
- https://www.bitget.com/docs/uta/websocket/public/Tickers-Channel
- https://www.bitget.com/docs/uta/quick-start
- https://www.bitget.com/api-doc/uta/websocket/public/Reality-OrderBook-Channel

REST discovery covers tokenized SPOT and linear USDT/USDC perpetuals. Coin-margined inverse contracts are excluded until their contract-unit conversion is modeled. Ordinary crypto spot and delivery futures are outside the canonical product types in this task.
