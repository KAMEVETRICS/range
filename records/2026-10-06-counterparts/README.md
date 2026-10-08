# Bitget's counterparts compared, 5 to 6 October 2026

Which venue makes the best counterpart for Bitget's stock perpetuals: trade.xyz perpetuals, Binance bStocks or Kraken xStocks? This one-off study sampled all three against Bitget every 30 seconds for a day. It ran beside Range, not inside it; Range itself pairs Bitget with trade.xyz only.

**Window:** 2026-10-05 23:15 to 2026-10-06 23:25 UTC, which includes a full US session. 2,900 samples of ten stocks: AAPL, AMZN, COIN, GOOGL, HOOD, META, MSFT, MSTR, NVDA and TSLA.

## Method

Each sample records the executable average price of buying and of selling $2,500:

- Bitget and trade.xyz, from Range's own pair evaluations (`/v1/pairs`), which walk each venue's order book.
- bStocks (`<T>BUSDT` on Binance spot) and xStocks (`<T>xUSD` on Kraken), by walking up to 50 levels of their public order books.

A gap clears its costs when it beats both legs' taker fees plus Range's 1 bp slippage buffer per leg. The fees are Bitget's 6 bps, trade.xyz's live 0.9 bps (9 bps on MSTR), and an assumed 10 bps for bStocks and xStocks. Funding is left out.

## Results

| Counterpart | Its own spread, median | Mid-price gap to Bitget, median | Cleared costs: buy there, sell Bitget | Cleared costs: buy Bitget, sell there |
| --- | ---: | ---: | ---: | ---: |
| trade.xyz | 1.1 bps | 6.4 bps | 1.9% of samples | 0.0% |
| Binance bStocks | 3.7 bps | 7.5 bps | 0.0% | 0.0% |
| Kraken xStocks | 4.1 bps | 9.0 bps | 0.1% | 0.0% |

trade.xyz has the tightest book, the closest price to Bitget and by far the lowest fee. Selling a spot token you don't hold also needs inventory or a borrow, which makes the last column harder still for bStocks and xStocks. `analyze.py` prints the same figures for each stock.

## Files

| File | Contents |
| --- | --- |
| [`samples.jsonl.gz`](samples.jsonl.gz) | Every sample, one JSON object per line (gzip-compressed) |
| [`sampler.py`](sampler.py) | The sampler, exactly as it ran on the server |
| [`analyze.py`](analyze.py) | The summary above, per stock and overall: `python3 analyze.py` |
