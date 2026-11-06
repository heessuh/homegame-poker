# Scheduled task: Mocha Poker budget check

Schedule: every day at 9:00 AM (cron `0 9 * * *`). Paste everything below the line as the task’s instructions.

---

You are checking the monthly spending guardrail for Mocha Poker, Fred’s private poker site on Fly.io (https://mochapoker.fly.dev). Do exactly the steps below and nothing else. Do not deploy, change settings, or email anyone except as described.

1. Read the access key from the file C:\Users\Windows\.mochapoker\usage-token (a single line of hex). Never print the key or put it in an email.

2. Fetch the usage report with Bash (curl), sending the key in an Authorization header (the old ?token= query form still works but is deprecated, because URLs get logged):
   `curl -s -w "\nHTTP %{http_code}" -H "Authorization: Bearer <KEY>" "https://mochapoker.fly.dev/admin/usage"`
   The first request after an idle period can take a few seconds while the server wakes up; if it fails or times out, wait 15 seconds and try once more.
   - HTTP 404: the meter key isn’t set up yet. Stop and report “Budget meter not configured yet (HTTP 404). No email sent.”
   - HTTP 401, or the site can’t be reached after the retry: stop and report the HTTP code or error. No email.
   - Otherwise parse the JSON: month, estimatedUsd, limitUsd, warnUsd, status ("ok" | "warn" | "limit"), runtimeHours, egressGB, notified.warn, notified.limit.

3. Decide whether to email (at most one email per run):
   - status "limit" and notified.limit is null → send the LIMIT email, then record it with level=limit.
   - status "warn" and notified.warn is null → send the WARNING email, then record it with level=warn.
   - Anything else → send nothing.

4. After sending, record it so it isn’t sent again this month:
   `curl -s -X POST -H "Authorization: Bearer <KEY>" "https://mochapoker.fly.dev/admin/usage/notified?level=<warn|limit>"`

Send emails with the Gmail connector’s send_message tool, to heessuh@gmail.com only, as plain text (no Markdown). Use American English and curly quotes and apostrophes. Show dollar amounts with two decimals.

WARNING email
Subject: Mocha Poker: 80% of this month’s $<limitUsd> budget used
Body:
Hi Fred,

Mocha Poker’s estimated Fly.io spending for <month> has reached $<estimatedUsd>, past the 80% warning level ($<warnUsd>) of the $<limitUsd> monthly budget.

Running time so far: <runtimeHours> hours. Data sent to players: <egressGB> GB.

Nothing has been paused. If spending reaches $<limitUsd>, new hands will stop until the 1st of next month.

— Mocha Poker budget check

LIMIT email
Subject: Mocha Poker paused: $<limitUsd> monthly budget reached
Body:
Hi Fred,

Mocha Poker’s estimated Fly.io spending for <month> has reached $<estimatedUsd>, the $<limitUsd> monthly budget.

The guardrail is on: hands in progress finish, but no new hands or tables start, and players see a notice that games resume on the 1st of next month. With nobody playing, the server shuts itself down, so spending stops.

To keep playing this month, raise the limit, for example to $10:
fly secrets set BUDGET_LIMIT_USD=10 -a mochapoker

Running time so far: <runtimeHours> hours. Data sent to players: <egressGB> GB.

— Mocha Poker budget check

5. Finish with a one-line summary: the month, the estimated spend, the status, and whether an email was sent.
