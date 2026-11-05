# Playing

Our own betting limits and game rules (5-Murder, FYST, the Hi/Lo games) are in [House Rules](HOUSE_RULES.md).

A quick guide for friends at the table. You don’t need an account or an app: just a link.

## Join from a link

1. Open the table link your host sent you. It looks like `…/#table-code`.
2. Type the name you want to show at the table (1 to 20 characters). Names must be unique, so if someone already uses yours, you’ll be shown as “Name2” or similar.
3. You’ll see the table right away. Refresh or close the tab and reopen the link any time, in the same browser: your seat and chips are kept, even if the server restarts.

## Pick an avatar

Next to your name you can show an avatar: an emoji (animals, card suits, or objects) or a number from 1 to 99.

- Pick one on the join screen, or
- Click your own seat or name at any time to change it.

## Sit down and buy in

1. Click **Sit here** on an empty seat.
2. Choose how many chips to bring. The buy-in must be between the table’s minimum and maximum, and it’s a whole number.
3. Click **Sit down**.

Your chips are the stack shown by your seat. Each hand, the blinds and bets come out of it, and winnings go into it. All money shows dollars and cents, like $40.00.

If you run out of chips, you’ll see “Out of chips — ask the dealer for a rebuy.” Only the dealer can add chips for you. Tournaments don’t allow rebuys.

Other buttons under your seat:

- **Sit out** pauses you without leaving the seat. When it’s your turn you are automatically checked or folded. Click **Sit in** to return.
- **Stand up** leaves the seat and cashes out your chips. During a hand, you leave after the hand finishes.

## The action bar

When it’s your turn, the action bar appears at the bottom.

- **Fold** gives up your hand.
- **Check** (when no one has bet) or **Call** (matching the current bet).
- **Bet** (when no one has bet yet) or **Raise to** (when someone has). Use the slider to pick an amount, or tap a preset:
  - **33%**, **50%**, **75%**, and **Pot** size your bet to that share of the pot.
  - **Max** is the largest legal amount.
  - A preset only appears if the house rules allow that amount, so some buttons may be missing.

Keyboard shortcuts work when you’re not typing in a box:

- **F** folds.
- **C** checks or calls.
- **R** bets or raises to the amount shown on the slider.

## The action timer

If the dealer turned on the action timer, a bar counts down on your seat when it’s your turn. If it runs out, you’re automatically checked or folded. The dealer sets the time limit (0 is off, or 5 to 300 seconds).

When your timer is running, you can tap **+15s** once per turn to add time. The dealer sets how many seconds that gives you (default 15, or 0 to turn it off).

If you time out twice in a row without acting, you’re put in **sitting out** mode. Click **Sit in** when you’re back.

## Awarding the pot

By default the dealer awards every pot. At showdown, everyone sees the winnings about to be awarded. You may see “Waiting for the dealer to award the pot.” Just wait; the dealer can adjust the amounts, then clicks **Next hand** to pay out and deal the next hand. Some tables pay out automatically, based on the cards.

## Games

- **No-Limit Texas Hold’em**, up to 10 players.
- **Pot-Limit Omaha** with 4 hole cards, up to 10 players.
- **5-Card Pot-Limit Omaha**, up to 8 players.
- **No-Limit Hold’em Hi/Lo (no qualifier)**, up to 10 players: every pot splits between the best high hand and the lowest hand, using any five of your seven cards for each. There’s no 8-or-lower rule — even a king-high low can win. Aces are low, straights and flushes don’t hurt a low, and pairs do (any five different cards beat any pair).
- **Pot-Limit Omaha Hi/Lo (8 or better)** with 4 hole cards, up to 10 players.
- **5-Card Pot-Limit Omaha Hi/Lo (8 or better)**, up to 8 players.
- **Pot-Limit Omaha Low**, 8 or better or with no qualifier, up to 10 players.
- **FYST**, an Omaha game where the second-best low wins, up to 10 players.
- **5-Murder**, up to 8 players.

The host picks the game and the stakes.

## Joining a game in progress

In Hold’em and Omaha cash games, if you sit down mid-game or miss the big blind while sitting out, you’re dealt in when the big blind reaches you. To play sooner, tap **Post and play next hand** to post one big blind. It counts toward your bet.

## Tournaments

If the host runs a tournament instead of a cash game:

- You start with the tournament’s starting stack. You don’t pick a buy-in, and there are no rebuys.
- The level clock shows the current blinds, a countdown, and the next level. Blinds go up at the next hand after the clock runs out.
- When you lose all your chips, you’re out and you get a finishing place.

## The Log, Ledger, History, and Standings tabs

- **Log** shows what has happened at the table in order, newest at the bottom, including each hand’s actions and results. Use **Full session log** for the whole session, or **Download log** for a .txt file.
- **Ledger** lists everyone’s buy-ins, cash-outs, and current stack, with the net result for each player. Use it to settle up at the end of the night.
- **History** lists every hand of the session. Tap one to see the board, the hands shown, the winners, the summary, and its shuffle proof.
- **Standings** shows the tournament standings: who is still in and who has finished where.

## Verify shuffle

Fairness check for any hand:

- Before the first card is dealt, the server publishes a fingerprint (a SHA-256 hash) of the shuffled deck. You can see it in that hand’s details in the **History** tab as the committed hash.
- After the hand, the server reveals the full deck order and a random salt.
- Click **Verify shuffle**. Your browser combines the salt and the deck, computes the fingerprint again, and compares it with the one published before the hand. A ✓ means they match, so the deck wasn’t changed after the hand started. A ✗ means they don’t.

You don’t have to click it: your browser checks each hand automatically and shows “✓ Hand #N verified” in the corner, or a red banner if a check fails. To check hands without using this site’s code, use **Copy fairness data** in **History** and paste it into the [outside verifier](https://heessuh.github.io/mochapoker-verify/). The **Fairness** tab shows whether anyone is getting better cards than chance would explain. Details are in [FAIRNESS.md](FAIRNESS.md).
