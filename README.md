# Gem Court Online

A real-time online board game for 2 to 4 players. Players create a room, share a 4-letter code or link, and play on their own phones or computers. The server holds the game and checks every move, so nobody can cheat.

## What is in this folder

| File | What it does |
| --- | --- |
| `server.js` | The online server: rooms, joining, reconnecting, and checking every move |
| `splendor-engine.js` | The game rules (also used by the page to show what you can afford) |
| `public/index.html` | The game screen players see in their browser |
| `splendor-engine.test.js`, `server.test.js` | Automated tests (23 checks, including full games for 2, 3 and 4 players) |
| `package.json` | Tells the host which add-ons to install and how to start the game |

## Put it online for free (about 15 minutes)

You need two free accounts: **GitHub** (to store the files) and **Render** (to run the game). Neither needs a credit card for what is described here. Website menus change from time to time, so a button may be named slightly differently.

### Step 1: Put the files on GitHub

1. Unzip this folder on your computer.
2. Sign up at github.com, then create a **New repository**. Name it `gem-court-online`. Leave it empty (no README).
3. On the new repository page, click **uploading an existing file**.
4. Drag **everything inside the unzipped folder** into the page: the files **and** the `public` folder. Do not upload a `node_modules` folder if you have one.
5. Click **Commit changes**. Check that you can see `server.js` and a `public` folder in the file list.

### Step 2: Run it on Render

1. Sign up at render.com (you can use your GitHub login).
2. Click **New +**, then **Web Service**, and choose your `gem-court-online` repository.
3. Set these:
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Click **Create Web Service** and wait a few minutes until it says **Live**.
5. Render shows your game address at the top, something like `https://gem-court-online.onrender.com`. Open it.

### Step 3: Test it

1. Open the address in a normal window and click **Create a game** (choose 3 players).
2. Open it again in a private window and on your phone. Enter the room code, or use the invite link.
3. Play a few turns. Try taking gems, a swap with the bank, buying a card, and refreshing a page in the middle of the game (you should return to your seat).

Then send the address to your friends.

## Good to know about the free plan

- **It goes to sleep** after about 15 minutes with nothing happening. The first person to open the link afterwards waits about a minute while it wakes up. Tell your friends to open the link a minute before you start.
- **A game is lost if the server restarts or goes to sleep in the middle.** That is fine for casual games with friends. Someone just starts a new room.
- Free plans change over time, so check Render's current free-plan terms if something stops working.

## If something goes wrong

- **The page does not load:** on Render, open the service and look at the **Logs** tab. Copy any red error text and show it to Claude.
- **Build failed:** check that `package.json` is at the top level of the repository (not inside another folder).
- **"Room not found":** the server may have restarted. Create a new room.

## For developers

- `npm install`, then `npm start` runs it on port 3000 (or the `PORT` environment variable).
- `npm test` runs all tests.
- Rules live only in `splendor-engine.js`. The server calls `applyAction()` for every move and sends each player `viewFor(state, seat)`, which hides the seed, the order of the card piles and other players' held cards.
