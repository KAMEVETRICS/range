# Capital Rotation — Track 3 Concept Brief

## Project boundary

This document preserves the capital-rotation concept as a separate **Track 3: AI Trading Desk** project. The main workspace will focus only on **arbitrage and funding opportunities** for Track 1.

The Track 3 system is a research workbench: AI gathers evidence, evaluates portfolio implications, and proposes a rotation, but the human trader makes the final decision. It does not autonomously execute trades.

## Thesis

Capital rarely leaves or enters every market at the same time. It rotates between U.S. equities, equity sectors, crypto, commodities, and defensive assets as macro conditions, volatility, liquidity, momentum, and sentiment change.

The proposed workbench converts those fragmented signals into one explainable answer:

> Where is capital moving, what evidence supports the move, what could invalidate it, and how would the proposed rotation change portfolio risk?

## Target user

The initial user is an active retail or professional multi-asset trader who:

- follows U.S. equities and crypto;
- rebalances weekly or when the market regime changes;
- wants evidence-backed allocation research without maintaining several data terminals;
- retains final control over every portfolio decision.

## Research workflow

1. **Receive a portfolio question**
   - Example: “Should I rotate from defensive equities into technology and crypto?”
2. **Measure the market regime**
   - Equity breadth and sector leadership
   - VIX and realized volatility
   - Treasury yields and U.S. dollar strength
   - Crypto market structure and sentiment
3. **Rank asset sleeves**
   - Broad U.S. equities
   - Equity sectors
   - BTC, ETH, and selected higher-beta crypto assets
   - Energy and metals
   - Cash or short-duration defensive exposure
4. **Evaluate portfolio impact**
   - Expected return contribution
   - Volatility and maximum-drawdown contribution
   - Correlation and concentration changes
   - Turnover and estimated transaction costs
5. **Generate an explainable recommendation**
   - Current regime
   - Preferred and avoided sleeves
   - Supporting evidence
   - Risk budget and invalidation conditions
6. **Require human approval**
   - The user decides whether to accept, modify, or reject the proposed rotation.

## Data and tool roles

### Bitget

- `bitget-mcp-server`: U.S. stock and ETF quotes, price history, fundamentals, news, and sentiment.
- `bitget-signal`: macro, crypto market intelligence, sentiment, technical analysis, and news.
- Bitget data should be visible in the demo as a primary research input rather than a cosmetic integration.

### TrueNorth

- Cross-asset historical bars and performance comparisons.
- Macro regime context such as the VIX, S&P 500, Nasdaq, U.S. dollar, and Treasury yields.
- Structured technical, derivatives, and market-event evidence.

### Cambrian

- On-chain activity, token security, holder concentration, and liquidity evidence.
- Social sentiment, sentiment shifts, and historical outcomes associated with prior signals.
- Independent confirmation or rejection of the crypto portion of a proposed rotation.

## Signal model

The workbench should keep signal generation deterministic and use the LLM for orchestration and explanation.

### Regime score

An illustrative regime score can combine normalized inputs:

```text
regime_score =
    0.25 × equity_trend
  + 0.20 × volatility_condition
  + 0.20 × rates_and_dollar_condition
  + 0.20 × crypto_market_condition
  + 0.15 × sentiment_condition
```

The result maps to one of three states:

- **Risk-on:** favor growth equities and crypto.
- **Neutral/selective:** hold diversified exposure and rotate only toward clear relative strength.
- **Risk-off:** reduce high-beta exposure and increase defensive or cash allocations.

### Asset score

Each asset sleeve receives a comparable score:

```text
asset_score =
    momentum
  + relative_strength
  + macro_alignment
  + sentiment_confirmation
  - volatility_penalty
  - drawdown_penalty
  - concentration_penalty
  - transaction_cost_penalty
```

The model should impose portfolio constraints after ranking assets:

- maximum allocation per asset and asset class;
- maximum portfolio volatility and drawdown target;
- minimum cash reserve;
- turnover ceiling;
- smaller position limits for high-beta assets;
- no recommendation when data is stale, contradictory, or incomplete.

## Initial 30-day research baseline

Research conducted for August 21–September 18, 2026 produced the following close-to-close results:

| Asset | Return | Maximum drawdown | Initial interpretation |
| --- | ---: | ---: | --- |
| SOL | +20.17% | -11.31% | Strongest momentum, but requires a smaller risk budget |
| ETH | +3.76% | -5.08% | Positive crypto-core exposure |
| XLK | +3.43% | -2.66% | Leading equity-sector exposure |
| BTC | +3.23% | -6.94% | Positive core risk asset |
| QQQ | +1.12% | -2.30% | Growth outperforming the broad market |
| XLE | +1.05% | -2.88% | Modest energy leadership |
| SPY | -0.53% | -2.47% | Broad market approximately flat |
| XLF | -2.82% | -4.61% | Relative weakness |
| XLU | -3.90% | -5.54% | Defensive utilities were not attracting capital |
| IWM | -5.29% | -5.35% | Small-cap underweight signal |

TrueNorth classified the environment as risk-on with contained volatility, while Cambrian showed positive crypto sentiment without a major new seven-day sentiment shock. The combined interpretation was **selective risk-on**, favoring technology and liquid crypto while retaining a defensive reserve because yields and the dollar remained firm.

This baseline is an example research run, not a permanent allocation rule or a prediction of future returns.

## Demo scenario

The demo should complete one end-to-end research task:

> “Given my current SPY, QQQ, BTC, ETH, SOL, gold, and cash exposures, should I rotate capital for the next market regime?”

The workbench should return:

1. the detected regime and confidence;
2. a ranked asset-sleeve table;
3. the proposed before-and-after allocation;
4. expected changes in volatility, drawdown, correlation, and concentration;
5. evidence from Bitget, TrueNorth, and Cambrian;
6. invalidation triggers and a “do nothing” alternative;
7. an explicit human approval step.

## Validation plan

The project should be evaluated on research quality rather than live trading profit alone:

- historical regime-classification stability;
- forward returns after rotation signals;
- maximum drawdown and downside capture;
- turnover and estimated transaction costs;
- performance against static 60/40, equal-weight, and buy-and-hold baselines;
- data freshness and provider agreement rate;
- explanation completeness and evidence traceability;
- user task-completion time and acceptance/rejection rate.

All results must distinguish observed, backtested, estimated, and targeted values.

## Track 3 submission fit

This concept fits **AI Trading Desk**, most naturally under either:

- **Personalized Research Workbench**, because it provides a repeatable multi-asset research process; or
- **Open Theme**, as a portfolio-aware AI portfolio manager/copilot.

The required submission should demonstrate an accessible interface and one complete path from a natural-language portfolio question to an actionable, evidence-backed insight. Human decision authority remains explicit throughout the workflow.

## Risks and limitations

- Thirty days is insufficient for validating a durable allocation model.
- Provider coverage and timestamps can differ across asset classes.
- Social sentiment is noisy and must not independently trigger a rotation.
- Backtests must prevent look-ahead bias and account for fees, slippage, and rebalance timing.
- Tokenized-stock prices may diverge from native shares because of liquidity, market hours, custody, or mint/redeem constraints.
- The system provides research support and is not personalized financial advice.

## Deferred work

Implementation of this Track 3 concept is intentionally deferred. Current development in the main workspace will focus exclusively on Track 1 arbitrage and funding opportunities.
