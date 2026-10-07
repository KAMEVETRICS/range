#!/usr/bin/env python3
"""Summarize the samples: each venue as Bitget's counterpart, per stock and overall.

Usage: python3 analyze.py [samples.jsonl.gz]

Gross gap: buying $2,500 on one venue and selling on the other, at executable averages. Net gap subtracts both legs'
taker fees and Range's 1 bp slippage buffer per leg. "buy V" means buy on the counterpart and sell the Bitget perp;
"sell V" means buy the Bitget perp and sell on the counterpart, which for a spot token needs inventory or a borrow.
"""
import gzip, json, os, statistics, sys, time

BITGET_TAKER = 6.0
# trade.xyz: its live taker fee (9 bps on MSTR). bStocks and xStocks: an assumed spot taker fee.
TAKER = {"xyz": 0.9, "bstock": 10.0, "xstock": 10.0}
SLIPPAGE = 2.0
path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples.jsonl.gz")
with (gzip.open if path.endswith(".gz") else open)(path, "rt") as samples:
    rows = [json.loads(line) for line in samples]

def quotes(row, ticker, venue):
    r = row["range"].get(ticker, {})
    if venue == "xyz":
        return r.get("hyperliquid_hip3_ask"), r.get("hyperliquid_hip3_bid")
    d = row[venue].get(ticker, {})
    return d.get("ask"), d.get("bid")

stats = {}
for row in rows:
    for ticker, r in row["range"].items():
        bg_ask, bg_bid = r.get("bitget_ask"), r.get("bitget_bid")
        if not bg_ask or not bg_bid:
            continue
        bg_mid = (bg_ask + bg_bid) / 2
        for venue in TAKER:
            ask, bid = quotes(row, ticker, venue)
            s = stats.setdefault((venue, ticker), {"n": 0, "thin": 0, "buy": [], "sell": [], "spread": [], "dev": []})
            s["n"] += 1
            if not ask or not bid:
                s["thin"] += 1
                continue
            cost = BITGET_TAKER + (9.0 if venue == "xyz" and ticker == "MSTR" else TAKER[venue]) + SLIPPAGE
            s["buy"].append((bg_bid - ask) / ask * 1e4 - cost)
            s["sell"].append((bid - bg_ask) / bg_ask * 1e4 - cost)
            s["spread"].append((ask - bid) / ((ask + bid) / 2) * 1e4)
            s["dev"].append(((ask + bid) / 2 - bg_mid) / bg_mid * 1e4)

def pct(values):
    return 100.0 * sum(1 for v in values if v > 0) / len(values) if values else 0.0

def utc(seconds):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(seconds))

times = [r["t"] for r in rows]
print(f"{len(rows)} samples, {utc(min(times))} to {utc(max(times))} UTC")
print(f"{'venue':7} {'stock':6} {'n':>4} {'thin':>4} {'own spread':>10} {'mid vs bitget':>13} {'best net':>9} {'buy V>0':>8} {'sell V>0':>9}")
for venue in TAKER:
    for ticker in sorted({t for v, t in stats if v == venue}):
        s = stats[(venue, ticker)]
        if not s["buy"]:
            print(f"{venue:7} {ticker:6} {s['n']:>4} {s['thin']:>4}   no usable quotes"); continue
        best = [max(b, c) for b, c in zip(s["buy"], s["sell"])]
        print(f"{venue:7} {ticker:6} {s['n']:>4} {s['thin']:>4} {statistics.median(s['spread']):>9.1f}b {statistics.median(s['dev']):>+12.1f}b "
              f"{statistics.median(best):>+8.1f}b {pct(s['buy']):>7.0f}% {pct(s['sell']):>8.0f}%")
    allb = [x for (v, t), s in stats.items() if v == venue for x in s["buy"]]
    alls = [x for (v, t), s in stats.items() if v == venue for x in s["sell"]]
    spreads = [x for (v, t), s in stats.items() if v == venue for x in s["spread"]]
    devs = [abs(x) for (v, t), s in stats.items() if v == venue for x in s["dev"]]
    print(f"{venue:7} {'ALL':6} median own spread {statistics.median(spreads):.1f}b, median |mid - bitget| {statistics.median(devs):.1f}b, "
          f"actionable: buy V {pct(allb):.1f}%, sell V {pct(alls):.1f}%\n")
