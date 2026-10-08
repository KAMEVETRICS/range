#!/usr/bin/env python3
"""Research, 2026-10-05: sample Bitget perps against trade.xyz perps, Binance bStocks and Kraken xStocks.

Every INTERVAL seconds, for each reviewed stock, records executable average prices at $2,500 on each side:
Bitget and trade.xyz from Range's own pair evaluations, bStocks and xStocks from their public order books.
One JSON line per sample in /root/research/arb-samples.jsonl. Public market data only.
"""
import json, time, urllib.request

TICKERS = ["AAPL", "AMZN", "COIN", "GOOGL", "HOOD", "META", "MSFT", "MSTR", "NVDA", "TSLA"]
NOTIONAL = 2500.0
INTERVAL = 30
OUT = "/root/research/arb-samples.jsonl"

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "range-research"}), timeout=15) as r:
        return json.load(r)

def fill(levels, notional=NOTIONAL):
    """Average price of buying (asks) or selling (bids) `notional` dollars, best level first; None if too thin."""
    remaining, cost, qty = notional, 0.0, 0.0
    for price, size in levels:
        price, size = float(price), float(size)
        take = min(remaining, price * size)
        cost += take; qty += take / price; remaining -= take
        if remaining <= 1e-9:
            return cost / qty
    return None

def book(asks, bids):
    return {"ask": fill(asks), "bid": fill(bids),
            "best_ask": float(asks[0][0]) if asks else None, "best_bid": float(bids[0][0]) if bids else None}

def sample():
    row = {"t": int(time.time()), "range": {}, "bstock": {}, "xstock": {}}
    try:
        pairs = get("http://127.0.0.1:4173/v1/pairs")["result"]["pairs"]
        for p in pairs:
            if p["strategy"] != "perp_spread":
                continue
            t = p["underlyingId"].split(":")[1]
            d = row["range"].setdefault(t, {})
            for side, key in (("buy", "ask"), ("sell", "bid")):
                leg = p[side]
                d[f"{leg['venue']}_{key}"] = float(leg["averagePrice"])
            d["evaluated_ms"] = p["evaluatedAtMs"]
    except Exception as error:
        row["range_error"] = str(error)[:200]
    for t in TICKERS:
        try:
            b = get(f"https://api.binance.com/api/v3/depth?symbol={t}BUSDT&limit=50")
            row["bstock"][t] = book(b["asks"], b["bids"])
        except Exception as error:
            row["bstock"][t] = {"error": str(error)[:120]}
        try:
            k = get(f"https://api.kraken.com/0/public/Depth?pair={t}xUSD&count=50&asset_class=tokenized_asset")
            if k.get("error"):
                raise RuntimeError(k["error"])
            levels = next(iter(k["result"].values()))
            row["xstock"][t] = book([l[:2] for l in levels["asks"]], [l[:2] for l in levels["bids"]])
        except Exception as error:
            row["xstock"][t] = {"error": str(error)[:120]}
    return row

while True:
    started = time.time()
    with open(OUT, "a") as out:
        out.write(json.dumps(sample()) + "\n")
    time.sleep(max(1.0, INTERVAL - (time.time() - started)))
