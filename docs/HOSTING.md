# Hosting

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

- **Variant**: No-Limit Hold’em, Pot-Limit Omaha (4 or 5 cards), or the Hi/Lo 8-or-better versions.
- **Small blind** and **Big blind**.
- **Max seats**: 2 to 10 for four-card games, 2 to 8 for five-card games.
- **Action timer**: seconds per action, or 0 to turn it off. Allowed values are 0 or 10 to 120.
- **Min buy-in** and **Max buy-in**.
- **Pot awarding**: **Automatic** or **Dealer decides** (see below).

Click **Apply settings** to save. If a hand is in progress, changes wait and apply at the start of the next hand; the panel shows “Pending changes apply next hand.” Changes that would seat someone in a seat you’re removing are refused until that player stands up.

## Manage players

Under **Players** you can see everyone seated with their stack.

- Enter an amount in **Stack adjust amount**, then use **+** or **−** next to a player to add or remove chips. Adjustments made during a hand are applied after it ends.
- **Kick** removes a player from their seat and stops them from sitting down again. If they’re in a hand, they leave after it ends. You cannot kick yourself.
- **Move chips** moves any amount from one player’s stack to another’s at any time. Between hands it happens right away; during a hand, it happens at the end of the current hand.
- **Timer** sets each player’s action timer: **Table default**, **No limit**, or 15 to 180 seconds. While someone is acting, you can click **+30s** to give them more time, or **Time out now** to act for them: check if possible, otherwise fold.

Every buy-in, rebuy, host adjustment, and cash-out is recorded in the **Ledger** tab, so you can settle up at the end of the night.

## Dealer-awarded pots

Under **Settings**, **Pot awarding** has two modes:

- **Automatic**: the server awards each pot based on the cards.
- **Dealer decides**: every hand ends with the pot held. The **Award** panel is prefilled with what the cards say. Click **Use suggested** to accept it, type any split you like, or click **All to <name>**. The **Award** button unlocks when the total matches the pot. The next hand waits for you.

## Tournaments

1. In the **Host** tab, set **Mode** to **Tournament**.
2. Pick a preset: **Turbo** (8-minute levels), **Standard** (15-minute levels), or **Deep** (20-minute levels). Or edit the starting stack, the late registration levels, and the blind-level table yourself.
3. Click **Apply**, then **Start game**. Everyone is re-stacked to the starting stack.

While a tournament runs:

- **Pause** also pauses the level clock.
- **Level −/+** and **Clock −1/+1 min** let you adjust the level and the clock.
- Players who stand up during a tournament are counted as eliminated.
- After there’s a winner, switch **Mode** back to **Cash**, or start another tournament.

Tournament chips never count in the cash ledger. Switching a table to tournament mode cashes everyone out in the ledger first. Switching back to cash leaves players with 0 chips and sitting out until they rebuy, and each rebuy is recorded as a buy-in.

## If the host goes offline

If you lose your connection (for example, your phone sleeps), the table keeps going for 60 seconds. If you haven’t reconnected by then, host status passes to another connected player: a seated player first, in seat order, or anyone connected if no one is seated. The log says “<name> is now the host.”

- If you reconnect within 60 seconds, you keep host status and nothing changes.
- If you reconnect later, you don’t get host status back automatically. The new host can use the controls.

## Limitations of this proof of concept

- Tables live in the server’s memory. A redeploy, a server restart, or the server shutting down while idle clears every table, including chips and the ledger.
- Settle the ledger before the night ends. Once the table is gone, its chips and history go with it, so start a fresh table next time.
