# Playing

A quick guide for friends at the table. You don’t need an account or an app: just a link.

## Join from a link

1. Open the table link your host sent you. It looks like `…/#table-code`.
2. Type the name you want to show at the table (1 to 20 characters). Names must be unique, so if someone already uses yours, you’ll be shown as “Name2” or similar.
3. You’ll see the table right away. Refresh or close the tab and reopen the link any time: your seat and chips are kept, as long as the host hasn’t restarted the server.

## Pick an avatar

Next to your name you can show an avatar: an emoji (animals, card suits, or objects) or a number from 1 to 99.

- Pick one on the join screen, or
- Click your own seat or name at any time to change it.

## Sit down and buy in

1. Click **Sit here** on an empty seat.
2. Choose how many chips to bring. The buy-in must be between the table’s minimum and maximum, and it’s a whole number.
3. Click **Sit down**.

Your chips are the stack shown by your seat. Each hand, the blinds and bets come out of it, and winnings go into it.

Other buttons under your seat:

- **Rebuy** adds chips. Between hands it happens right away; during a hand it waits until the hand ends. Tournaments don’t allow rebuys.
- **Sit out** pauses you without leaving the seat. When it’s your turn you are automatically checked or folded. Click **Sit in** to return.
- **Stand up** leaves the seat and cashes out your chips. During a hand, you leave after the hand finishes.

## The action bar

When it’s your turn, the action bar appears at the bottom.

- **Fold** gives up your hand.
- **Check** (when no one has bet) or **Call** (matching the current bet).
- **Bet** (when no one has bet yet) or **Raise to** (when someone has). Use the slider or the number box to pick an amount. The presets help:
  - **Min** is the smallest legal amount.
  - **½ Pot**, **¾ Pot**, and **Pot** size your bet to that fraction of the pot after your call.
  - **All-in** (in No-Limit Hold’em) or **Max** (in pot-limit games) puts in the most you’re allowed.

Keyboard shortcuts work when you’re not typing in a box:

- **F** folds.
- **C** checks or calls.
- **R** bets or raises to the amount shown on the slider.

## The action timer

If the host turned on the action timer, a bar counts down on your seat when it’s your turn. If it runs out, you’re automatically checked or folded.

If you time out twice in a row without acting, you’re put in **sitting out** mode. Click **Sit in** when you’re back.

## Dealer-awarded pots

At some tables the dealer decides who gets the pot. When that happens, you’ll see “Waiting for the dealer to award the pot.” Just wait; the dealer makes the award and the game goes on.

## Games

- **No-Limit Texas Hold’em**, up to 10 players.
- **Pot-Limit Omaha** with 4 hole cards, up to 10 players.
- **5-Card Pot-Limit Omaha**, up to 8 players.
- **No-Limit Hold’em Hi/Lo (8 or better)**, up to 10 players: the pot splits between the best high hand and the best low hand (five different cards 8 or lower, any five of your seven). If nobody has a low, the high hand takes it all.
- **Pot-Limit Omaha Hi/Lo (8 or better)** with 4 hole cards, up to 10 players.
- **5-Card Pot-Limit Omaha Hi/Lo (8 or better)**, up to 8 players.

The host picks the game and the stakes.

## Tournaments

If the host runs a tournament instead of a cash game:

- You start with the tournament’s starting stack. You don’t pick a buy-in, and there are no rebuys.
- The level clock shows the current blinds, a countdown, and the next level. Blinds go up at the next hand after the clock runs out.
- When you lose all your chips, you’re out and you get a finishing place.

## The Log, Ledger, Last hand, and Standings tabs

- **Log** shows what has happened at the table in order, newest at the bottom, including each hand’s actions and results.
- **Ledger** lists everyone’s buy-ins, cash-outs, and current stack, with the net result for each player. Use it to settle up at the end of the night.
- **Last hand** shows the most recent completed hand: the board, the results, and the **Verify shuffle** tool.
- **Standings** shows the tournament standings: who is still in and who has finished where.

## Verify shuffle

Fairness check for the hand you just played:

- Before the first card is dealt, the server publishes a fingerprint (a SHA-256 hash) of the shuffled deck. You can see it in the **Last hand** tab as the committed hash.
- After the hand, the server reveals the full deck order and a random salt.
- Click **Verify shuffle**. Your browser combines the salt and the deck, computes the fingerprint again, and compares it with the one published before the hand. A ✓ means they match, so the deck wasn’t changed after the hand started. A ✗ means they don’t.
