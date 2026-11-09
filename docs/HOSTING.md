# Hosting

The rules the site enforces for our games are written up in [House Rules](HOUSE_RULES.md). In the Host tab, **House limit** (Hold’em and Omaha) and **5-Murder stakes** hold those settings, and money always shows dollars and cents.

A guide for the person running the game night.

## Create a table and invite people

1. Open the web app and click **Create a table**. You get a table code and the page address changes to include it.
2. Click **Copy link** in the table header and send it to your friends. Anyone with the link can join with a name; no accounts are needed.
3. You are the host. The host controls live in the **Host** tab of the side panel.

## Start and pause

- **Start game** begins play. The first hand deals once at least two seated players have chips.
- **Pause** lets the current hand finish, then holds the table. **Resume** starts it again.

## Change the game

Use the game dropdown in the top bar. If no hand is running, the game changes right away. Otherwise it changes from the next hand, and a “Next hand: …” badge shows what’s coming.

## Settings

In the **Host** tab, under **Settings**, you can change:

- **Variant**: any of the games listed in [House Rules](HOUSE_RULES.md).
- **Small blind** and **Big blind**.
- **Max seats**: 2 to 10 for four-card games, 2 to 8 for five-card games.
- **Action timer**: seconds per action, or 0 to turn it off. Allowed values are 0 or 5 to 300.
- **Player extension**: how many seconds a player gets when they tap **+15s** on their timer. Default 15; 0 turns it off.
- **Min buy-in** and **Max buy-in**.
- **Pot awarding**: **Automatic** (the default) or **Dealer decides** (see below).

Click **Save as house defaults** to make this table’s settings (house limits, 5-Murder stakes, timers, buy-ins, and game) the starting point for the new tables **you** create from this device. Defaults are kept per host: they never change the tables other people create.

Click **Apply settings** to save. If a hand is in progress, changes wait and apply at the start of the next hand; the panel shows “Pending changes apply next hand.” Changes that would seat someone in a seat you’re removing are refused until that player stands up.

## Manage players

Under **Players** you can see everyone seated with their stack.

- Enter an amount in **Stack adjust amount**, then use **+** or **−** next to a player to add or remove chips. Adjustments made during a hand are applied after it ends.
- **Sit out / Sit in** marks a player as away if they forgot to do it themselves, so they aren’t dealt in (in a tournament they’re still dealt and fold automatically). Click **Sit in** to deal them back in.
- **Rebuy** records a buy-in in the ledger and adds chips to a player’s stack. It also deals a busted player back in.
- **Cash out** pays a player’s stack out and records it in the ledger.
- **Kick** removes a player from their seat and stops them from sitting down again. If they’re in a hand, they leave after it ends. You cannot kick yourself.
- **Move chips** moves any amount from one player’s stack to another’s at any time. Between hands it happens right away; during a hand, it happens at the end of the current hand.
- **Timer** sets each player’s action timer: **Table default**, **No limit**, or 15 to 180 seconds. While someone is acting, you can click **+30s** to give them more time, or **Time out now** to act for them: check if possible, otherwise fold.

Every buy-in, rebuy, host adjustment, and cash-out is recorded in the **Ledger** tab, so you can settle up at the end of the night. Everything you do as host also goes in the dealer log, which every player can see and which their browsers check for tampering.

## Shuffle seats

**Shuffle seats** in the **Host** tab reseats everyone at random among the occupied seats. Open seats stay open, and at least one player always moves. During a hand, the shuffle waits until the hand ends. The dealer button stays at its seat, so it moves on to the next seat as usual. Every shuffle, with the new seating, is recorded in the dealer log.

## Pot awarding

Under **Settings**, **Pot awarding** has two modes:

- **Automatic** (the default): the server awards each pot based on the cards.
- **Dealer decides**: the dealer finalizes every pot. At showdown, everyone sees the winnings about to be awarded. The amounts start at what the cards say. If you change them, you must type a short reason, and the dealer log records the suggested payout, the actual payout and your reason. Click **Reset to suggested** to undo your edits, then **Next hand** to pay out and deal on.

## Tournaments

1. In the **Host** tab, set **Mode** to **Tournament**.
2. Pick a preset: **Turbo** (8-minute levels), **Standard** (15-minute levels), or **Deep** (20-minute levels). Or edit the starting stack, the late registration levels, and the blind-level table yourself. Each level has its own small blind, big blind and length (1 to 120 minutes), so you can mix lengths. **Set every level to (minutes)** applies one length to all the normal levels at once. The ☕ button inserts a **break** after a level.
3. Click **Apply**, then **Start game**. Everyone is re-stacked to the starting stack.

While a tournament runs:

- **Edit the levels still to come.** The Host tab shows the level table with the levels already played locked. Change blinds, level lengths, add or remove levels, or insert breaks, then click **Apply level changes**. The level being played keeps its clock; its blinds can change but apply from the next hand. You cannot turn the current level into a break or remove it. Every change is recorded in the dealer log.
- **Breaks** stop new hands while they run (a hand already in progress finishes), the clock keeps counting down, and a break does not use up late registration. The first and last level cannot be breaks.
- **Pause** also pauses the level clock.
- **Level −/+** and **Clock −1/+1 min** let you adjust the level and the clock.
- Players who stand up during a tournament are counted as eliminated.
- After there’s a winner, switch **Mode** back to **Cash**, or start another tournament.

Betting in tournaments is standard: Omaha is pot-limit and Hold’em is no-limit. The house limit (up to $2 per bet or raise) only applies to cash games, where it replaces the Omaha pot limit.

Tournament chips never count in the cash ledger. Switching a table to tournament mode cashes everyone out in the ledger first. Switching back to cash leaves players with 0 chips and sitting out until you rebuy them. Each rebuy is recorded as a buy-in.

## Locking the table

In the **Host** tab, **Lock table** stops new people from joining. Players who already sat at the table can still reconnect. Click **Unlock table** to let new people in. Table links made by **Create a table** now use 12 random characters, so they are hard to guess; share the link only with your group.

## If the host goes offline

If you lose your connection (for example, your phone sleeps), the table keeps going for 60 seconds. If you haven’t reconnected by then, host status passes to the connected **seated** player in the lowest seat. Someone who is only watching never becomes host. If nobody seated is online, the table keeps the absent host until they return. The log says “<name> is now the host.”

- If you reconnect within 60 seconds, you keep host status and nothing changes.
- If you reconnect later, you don’t get host status back automatically. The new host can use the controls.

## Saved games

Tables are saved on the server after every change. If the server restarts, the power goes out, or someone’s connection drops, the game comes back exactly where it was: the current hand, cards, stacks, ledger, and history. Players get their seat back by reopening the table link in the same browser. Tables that nobody opens for 14 days are deleted.

Settling up at the end of the night is still good practice: check the **Ledger** before everyone heads home.
