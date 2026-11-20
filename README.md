# GTA VI trophy rarity forecast

Entry for [make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/keyzoxyz/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/keyzoxyz/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

## What it forecasts

For each of GTA VI's 55 PlayStation 5 trophies, five quantiles of its Exophase earn rate at a target
instant a week after launch, scored by mean pinball loss on the logit scale.

## The idea

Exophase prints a trophy's earn rate as

```
rate = 100 * earners / tracked
```

`tracked` is the number of players Exophase happens to track for the game. It does not move with play:
it moves in one step whenever Exophase refreshes the game. On launch night that was 638 → 3,868 in a
single refresh, and every printed rate fell to about a sixth of itself while no player's trophy
changed. `earners` move smoothly, as players actually earn things.

So the entry forecasts in the **earners space**: it converts every read into the earners that read
implies, fits a growth curve there, forecasts the tracked count separately, and divides. A refresh then
moves the numerator's history and the denominator's forecast together, which is the same arithmetic the
page performs — instead of being a surprise the band has to cover.

Two details that decide the score:

* **The denominator is fitted only on the current cohort's segment.** A single line through the whole
  history measures the refresh step rather than the drift, and extrapolates the step — over-forecasting
  `tracked` by multiples and pushing every rate far too low. Fitting from the last refresh onward fixes
  that.
* **The band is the sum in quadrature of three honest parts**: the growth fit's own residual, a horizon
  random walk (0.5 logit / √day), and a refresh-risk term. Pinball loss charges a band for being too
  wide at *every* trophy and charges a median for missing at every trophy, so the width is measured, not
  guessed.

Censored ends are handled explicitly: a trophy at 100% is held at 99.9 (only rounding moves it), and a
trophy at 0.00% is bounded near the smallest positive rate the case shows rather than extrapolated from
zero, which has no logit.

## Measured

Loss is the contest's own metric (mean pinball loss on the logit scale, lower is better).

| Case | House baseline | This entry |
|---|---|---|
| Practice p00 (launch night, 90 min) | 1.51 | **0.121** |
| Practice p01 (launch night, 90 min) | 1.51 | **0.121** |
| Synthetic final, cohort growing | 0.320 | **0.178** |
| Synthetic final, cohort frozen | — | **0.176** |

Coverage holds at 0.98 on every case, and the typical miss is under 0.02 points on the final-like cases.

## Run

```bash
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` in the input directory and writes `<id>.out` beside it. Node 22, standard library
only, no network. Runs in about 0.2 s per case against an 8 s cap.

## License

MIT — see [LICENSE](LICENSE).