# Budget Guardrail

Fly.io has no spending caps or billing alerts of its own, so Mocha Poker keeps its own: **at most $5 a month**.

## How it works

- **The server meters its own cost** for the current month (UTC): the hours it runs, the data it sends to players, and the storage disk. It prices them at Fly.io’s rates, rounded up on purpose so the estimate errs high:

  | Item | Rate used |
  |---|---|
  | Server time | $0.0035 per hour |
  | Data to players | $0.04 per GB |
  | Storage disk | 1 GB × $0.15 per GB-month |
  | Other fixed costs | $0.10 per month |

- **At $4.00 (80%)**, the meter records a warning. Nothing is paused.
- **At $5.00**, the guardrail engages:
  - Hands in progress finish.
  - No new hands or tables start.
  - Players see: “Mocha Poker has reached its $5 budget for this month. Games resume on the 1st.”
  - With nobody playing, the server shuts down on its own, so spending stops.
- **On the 1st of the month** the meter resets and games resume on their own.

At normal use (7–8 players, about 15 hours a month) the estimate is around $0.30 a month, so the guardrail is there for the unexpected: someone leaving a tab open for weeks, or a bug that keeps the server busy.

The meter is an estimate. Fly.io’s dashboard (Billing) shows the real bill.

## Changing the limit

To raise or lower the limit, for example to $10:

```bash
fly secrets set BUDGET_LIMIT_USD=10 -a mochapoker
```

Send the token in an `Authorization: Bearer <token>` header (not in the URL, where it would be logged). The old `?token=` form still works but is deprecated.

Setting a secret restarts the server, which lifts the pause if the new limit is above this month’s spend.

## Setup

Both one-time steps were completed on November 4, 2026.

1. **Meter key:** stored as the Fly.io secret `USAGE_TOKEN`. The owner’s copy is in `~/.mochapoker/usage-token`. The owner report at `/admin/usage` needs this key.
2. **Daily email check:** the scheduled task “Mocha Poker budget check” in the Claude desktop app runs every morning at about 9:00. It reads the meter and emails heessuh@gmail.com, once at the 80% warning and once at the $5 limit, never more than once per level per month. Scheduled tasks run while the Claude app is open; if it’s closed at that time, the check runs the next time the app opens. Its instructions are in [budget-check-task.md](budget-check-task.md).

To set the key again (for example, after replacing it), in Git Bash:

```bash
fly secrets set USAGE_TOKEN="$(cat ~/.mochapoker/usage-token)" -a mochapoker
```
