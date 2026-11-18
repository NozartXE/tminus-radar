# tminus-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/NozartXE/tminus-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/NozartXE/tminus-radar/reward.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

T-Minus is a token launch radar with a countdown clock. It prices every protocol that
records no token yet in two stages. First, what the launch would be worth: a robust size
curve fitted on the snapshot's own traded tokens, with a log-growth tilt, chosen by
leave-one-out validation over six rival forms (median miss 3.05x, against 4.65x for one
flat multiple). Second, whether the window opens while you farm: a current-status launch
clock fitted on all 442 comparable protocols in the snapshot (244 already record a token,
198 still wait) turns each protocol's age, size and chain count into a next-12-months
launch rate, cross-validated out of sample (AUC 0.68). Every farm plan is then priced by
expected value — the clock rate times your slice if a launch happens, minus gas, forgone
yield and your hours — and lands on a verdict: worth farming, marginal, or skip. The page
re-runs both fits in your browser and checks every rank, value, band, rank range and
verdict on the board against them.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=hr2ehgtj&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
