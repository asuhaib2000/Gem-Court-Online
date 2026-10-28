/**
 * Gem Court rules engine
 * ----------------------
 * Pure and deterministic: no UI, no network, no timers, no randomness except
 * the seeded generator used in createGame(). Works in Node (ES modules) and
 * in the browser (<script type="module">).
 *
 * The SERVER owns the real game state. Clients send an action, the server
 * calls applyAction(), then sends each player viewFor(state, seat).
 *
 * Gem colour codes: w = pearl, u = sapphire, g = emerald, r = ruby,
 *                   k = onyx,  y = gold (wildcard; it can never be taken from
 *                   the bank, swapped or returned)
 *
 * SETUP (scaled from a 4-player set, see setupFor(n)):
 *   gems per colour = round(7n/4)  -> 4 / 5 / 7   for 2 / 3 / 4 players
 *   gold            = round(5n/4)  -> 3 / 4 / 5
 *   nobles          = n + 1
 *   open cards      = always 4 per tier
 *   cards per tier  = round(40n/4), round(30n/4), round(20n/4)
 *                     -> 20/15/10 (2p), 30/23/15 (3p), 40/30/20 (4p)
 *
 * ACTIONS (what a client may send; exactly one per turn):
 *   { type: 'takeGems', colors: ['w','u','g'] }   1, 2 or 3 different colours
 *   { type: 'takeGems', colors: ['r','r'] }       2 of one colour (bank has 4+)
 *   { type: 'swap', take: ['r'], give: ['w'] }    take 1 (or 2 of one colour if
 *   { type: 'swap', take: ['r','r'], give: ['w','u'] }  the bank has 4+) and
 *                                                 give back the same number of
 *                                                 your own gems. Not gold, and
 *                                                 not the colour you take.
 *                                                 Allowed at any token count.
 *   { type: 'reserve', tier: 0, index: 2 }        hold a face-up card (get gold)
 *   { type: 'reserve', tier: 1, fromDeck: true }  hold the top card blind
 *   { type: 'buy', tier: 2, index: 0 }            buy a face-up card
 *   { type: 'buy', reservedIndex: 1 }             buy a held card
 *   { type: 'discard', tokens: { w: 1, u: 1 } }   when over 10 tokens (no gold)
 *   { type: 'chooseNoble', nobleId: 'n3' }        when 2+ nobles qualify
 *   { type: 'pass' }                              only if nothing else is legal
 *
 * PHASES (state.phase):
 *   'action'  current player does one of the actions above
 *   'discard' current player must return tokens down to 10
 *   'noble'   current player must pick one of state.pendingNobles
 *   'over'    game finished; see state.winners (and state.endedByStalemate)
 *
 * END OF GAME: when a player reaches 15 points the round is completed so
 * everyone has the same number of turns. Ties go to the fewest cards.
 * Stalemate rule: if every player passes in a row, the game ends at once and
 * the highest score wins.
 */

export const COLORS = ['w', 'u', 'g', 'r', 'k'];
export const GEMS = [...COLORS, 'y'];
export const WIN_POINTS = 15;
export const MAX_TOKENS = 10;
export const MAX_RESERVED = 3;
export const OPEN_PER_TIER = 4;
const DECK_TOTALS_FOR_4 = [40, 30, 20];

/** The scaled setup for n players (2 to 4). */
export const setupFor = (n) => ({
  gemsEach: Math.round((7 * n) / 4),
  gold: Math.round((5 * n) / 4),
  nobles: n + 1,
  openPerTier: OPEN_PER_TIER,
  deckTotals: DECK_TOTALS_FOR_4.map((x) => Math.round((x * n) / 4)),
});

/* ---------- small helpers ---------- */

const clone = (x) => JSON.parse(JSON.stringify(x));
const emptyTokens = () => ({ w: 0, u: 0, g: 0, r: 0, k: 0, y: 0 });
const isInt = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
const fail = (error) => ({ ok: false, error });
const ok = (state) => ({ ok: true, state });

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function combos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...rest] = arr;
  return [...combos(rest, k - 1).map((c) => [head, ...c]), ...combos(rest, k)];
}

/* ---------- content generation (original cards, not the official set) ---------- */

// Cost patterns per colour: [points, [gem counts spread over other colours]].
// Tier I: 8 per colour, Tier II: 6 per colour, Tier III: 4 per colour.
const TPL = [
  [[0, [1, 1, 1, 1]], [0, [1, 1, 1, 2]], [0, [1, 2, 2]], [0, [2, 2]], [0, [3]], [0, [1, 1, 3]], [0, [1, 2]], [1, [4]]],
  [[1, [2, 2, 3]], [1, [1, 3, 2]], [2, [5]], [2, [2, 4, 1]], [2, [5, 3]], [3, [6]]],
  [[3, [3, 3, 5, 3]], [4, [7]], [4, [6, 3, 3]], [5, [7, 3]]],
];

/** Card decks for n players: each colour keeps the same number of cards. */
export function generateCards(rand, n = 4) {
  const decks = [];
  for (let t = 0; t < 3; t++) {
    const total = Math.round((DECK_TOTALS_FOR_4[t] * n) / 4);
    const base = Math.floor(total / 5);
    const extra = shuffle(COLORS, rand).slice(0, total - 5 * base);
    const d = [];
    for (const color of COLORS) {
      const k = base + (extra.includes(color) ? 1 : 0);
      shuffle(TPL[t], rand)
        .slice(0, k)
        .forEach(([points, v], i) => {
          const others = shuffle(COLORS.filter((x) => x !== color), rand);
          const cost = {};
          v.forEach((q, j) => (cost[others[j]] = q));
          d.push({ id: `t${t}-${color}${i}`, tier: t, color, points, cost });
        });
    }
    decks.push(shuffle(d, rand));
  }
  return decks;
}

export function generateNobles(rand) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const k = rand() < 0.5 ? 2 : 3;
    const cols = shuffle(COLORS, rand).slice(0, k);
    const req = {};
    cols.forEach((c) => (req[c] = k === 2 ? 4 : 3));
    out.push({ id: `n${i}`, points: 3, req });
  }
  return out;
}

/* ---------- setup ---------- */

/** createGame(['Asha','Ravi'], 12345). Player 0 goes first. */
export function createGame(names, seed = Date.now() >>> 0) {
  const n = names.length;
  if (n < 2 || n > 4) throw new Error('Gem Court needs 2 to 4 players.');
  const rand = mulberry32(seed);
  const setup = setupFor(n);
  const decks = generateCards(rand, n);
  const board = decks.map((d) => d.splice(0, OPEN_PER_TIER));
  const nobles = generateNobles(rand).slice(0, setup.nobles);
  const e = setup.gemsEach;
  return {
    version: 2,
    seed,
    numPlayers: n,
    players: names.map((name) => ({ name, tokens: emptyTokens(), cards: [], reserved: [], nobles: [] })),
    bank: { w: e, u: e, g: e, r: e, k: e, y: setup.gold },
    decks,
    board,
    nobles,
    current: 0,
    round: 1,
    phase: 'action',
    pendingNobles: [],
    finalRound: false,
    passes: 0,
    endedByStalemate: false,
    winners: null,
    lastEvent: null,
  };
}

/* ---------- queries ---------- */

export const discounts = (p) => {
  const d = { w: 0, u: 0, g: 0, r: 0, k: 0 };
  p.cards.forEach((c) => d[c.color]++);
  return d;
};
export const score = (p) => p.cards.reduce((a, c) => a + c.points, 0) + p.nobles.reduce((a, n) => a + n.points, 0);
export const tokenCount = (p) => GEMS.reduce((a, g) => a + p.tokens[g], 0);

/** What the player would pay for a card (tokens incl. gold), or null if unaffordable. */
export function payment(p, card) {
  const d = discounts(p);
  const pay = emptyTokens();
  let gold = 0;
  for (const c of COLORS) {
    const need = Math.max(0, (card.cost[c] || 0) - d[c]);
    const use = Math.min(need, p.tokens[c]);
    pay[c] = use;
    gold += need - use;
  }
  if (gold > p.tokens.y) return null;
  pay.y = gold;
  return pay;
}

/** All legal actions for the current player (useful for AI, tests and enabling buttons). */
export function getLegalActions(s) {
  if (s.phase === 'over') return [];
  const p = s.players[s.current];
  if (s.phase === 'discard') {
    return [{ type: 'discard', mustDiscard: tokenCount(p) - MAX_TOKENS }];
  }
  if (s.phase === 'noble') {
    return s.pendingNobles.map((id) => ({ type: 'chooseNoble', nobleId: id }));
  }
  const acts = [];
  for (let t = 0; t < 3; t++) {
    s.board[t].forEach((card, index) => {
      if (!card) return;
      if (payment(p, card)) acts.push({ type: 'buy', tier: t, index });
      if (p.reserved.length < MAX_RESERVED) acts.push({ type: 'reserve', tier: t, index });
    });
    if (p.reserved.length < MAX_RESERVED && s.decks[t].length) acts.push({ type: 'reserve', tier: t, fromDeck: true });
  }
  p.reserved.forEach((card, reservedIndex) => {
    if (payment(p, card)) acts.push({ type: 'buy', reservedIndex });
  });
  const avail = COLORS.filter((c) => s.bank[c] > 0);
  for (let k = 1; k <= 3; k++) combos(avail, k).forEach((colors) => acts.push({ type: 'takeGems', colors }));
  COLORS.forEach((c) => {
    if (s.bank[c] >= 4) acts.push({ type: 'takeGems', colors: [c, c] });
  });
  // swaps with the bank
  COLORS.forEach((c) => {
    const have = COLORS.filter((g) => g !== c && p.tokens[g] > 0);
    if (s.bank[c] >= 1) have.forEach((g) => acts.push({ type: 'swap', take: [c], give: [g] }));
    if (s.bank[c] >= 4) {
      for (let i = 0; i < have.length; i++) {
        for (let j = i; j < have.length; j++) {
          if (i === j && p.tokens[have[i]] < 2) continue;
          acts.push({ type: 'swap', take: [c, c], give: [have[i], have[j]] });
        }
      }
    }
  });
  if (acts.length === 0) acts.push({ type: 'pass' });
  return acts;
}

/* ---------- applying actions ---------- */

/**
 * applyAction(state, seat, action) -> { ok: true, state } | { ok: false, error }
 * Never mutates the state you pass in. `seat` is the player index the request
 * came from (the server must work this out from the connection, never trust the client).
 */
export function applyAction(state, seat, action) {
  if (!action || typeof action.type !== 'string') return fail('Invalid action.');
  if (state.phase === 'over') return fail('The game is over.');
  if (seat !== state.current) return fail('It is not your turn.');
  const s = clone(state);
  const p = s.players[seat];
  s.lastEvent = null;
  if (s.phase === 'action') return doAction(s, p, seat, action);
  if (s.phase === 'discard') return doDiscard(s, p, seat, action);
  if (s.phase === 'noble') return doNoble(s, p, seat, action);
  return fail('Unknown game phase.');
}

function doAction(s, p, seat, a) {
  switch (a.type) {
    case 'takeGems': {
      const cols = a.colors;
      if (Array.isArray(cols) && cols.includes('y')) return fail('Gold cannot be taken from the bank.');
      if (!Array.isArray(cols) || cols.length < 1 || cols.length > 3 || cols.some((c) => !COLORS.includes(c))) {
        return fail('Take 1, 2 or 3 different gems, or 2 of the same colour.');
      }
      if (cols.length === 1) {
        if (s.bank[cols[0]] < 1) return fail('That colour is not in the bank.');
      } else if (cols.length === 2 && cols[0] === cols[1]) {
        if (s.bank[cols[0]] < 4) return fail('Taking two of one colour needs 4 or more in the bank.');
      } else {
        if (new Set(cols).size !== cols.length) return fail('Gems must be different colours.');
        if (cols.some((c) => s.bank[c] < 1)) return fail('That colour is not in the bank.');
      }
      cols.forEach((c) => {
        s.bank[c]--;
        p.tokens[c]++;
      });
      s.lastEvent = { player: seat, type: 'takeGems', colors: cols };
      break;
    }
    case 'swap': {
      const { take, give } = a;
      if (!Array.isArray(take) || !Array.isArray(give) || take.length < 1 || take.length > 2 || give.length !== take.length) {
        return fail('A swap takes 1 gem (or 2 of one colour) and gives back the same number of your own gems.');
      }
      if ([...take, ...give].includes('y')) return fail('Gold cannot be swapped.');
      if ([...take, ...give].some((c) => !COLORS.includes(c))) return fail('Invalid colour.');
      if (take.length === 2 && take[0] !== take[1]) return fail('Two gems must be the same colour.');
      const c = take[0];
      if (s.bank[c] < (take.length === 1 ? 1 : 4)) {
        return fail(take.length === 1 ? 'That colour is not in the bank.' : 'Taking two of one colour needs 4 or more in the bank.');
      }
      if (give.includes(c)) return fail('You cannot give back the colour you are taking.');
      const need = {};
      give.forEach((g) => (need[g] = (need[g] || 0) + 1));
      for (const g of Object.keys(need)) {
        if (p.tokens[g] < need[g]) return fail('You do not have those gems to give back.');
      }
      take.forEach((x) => {
        s.bank[x]--;
        p.tokens[x]++;
      });
      give.forEach((x) => {
        p.tokens[x]--;
        s.bank[x]++;
      });
      s.lastEvent = { player: seat, type: 'swap', take, give };
      break;
    }
    case 'reserve': {
      if (p.reserved.length >= MAX_RESERVED) return fail('You can hold at most 3 cards.');
      if (!isInt(a.tier, 0, 2)) return fail('Invalid tier.');
      let card;
      if (a.fromDeck) {
        if (!s.decks[a.tier].length) return fail('That deck is empty.');
        card = s.decks[a.tier].shift();
        s.lastEvent = { player: seat, type: 'reserve', tier: a.tier, fromDeck: true };
      } else {
        if (!isInt(a.index, 0, OPEN_PER_TIER - 1) || !s.board[a.tier][a.index]) return fail('No card there.');
        card = s.board[a.tier][a.index];
        s.board[a.tier][a.index] = s.decks[a.tier].shift() || null;
        s.lastEvent = { player: seat, type: 'reserve', tier: a.tier, card };
      }
      p.reserved.push(card);
      if (s.bank.y > 0) {
        s.bank.y--;
        p.tokens.y++;
      }
      break;
    }
    case 'buy': {
      let card;
      if (a.reservedIndex !== undefined) {
        if (!isInt(a.reservedIndex, 0, MAX_RESERVED - 1) || !p.reserved[a.reservedIndex]) return fail('No held card there.');
        card = p.reserved[a.reservedIndex];
      } else {
        if (!isInt(a.tier, 0, 2) || !isInt(a.index, 0, OPEN_PER_TIER - 1) || !s.board[a.tier][a.index]) return fail('No card there.');
        card = s.board[a.tier][a.index];
      }
      const pay = payment(p, card);
      if (!pay) return fail('You cannot afford that card.');
      GEMS.forEach((g) => {
        p.tokens[g] -= pay[g];
        s.bank[g] += pay[g];
      });
      if (a.reservedIndex !== undefined) p.reserved.splice(a.reservedIndex, 1);
      else s.board[a.tier][a.index] = s.decks[a.tier].shift() || null;
      p.cards.push(card);
      s.lastEvent = { player: seat, type: 'buy', card };
      break;
    }
    case 'pass': {
      const legal = getLegalActions(s);
      if (!(legal.length === 1 && legal[0].type === 'pass')) return fail('You can only pass when you have no other move.');
      s.lastEvent = { player: seat, type: 'pass' };
      s.passes += 1;
      return resolveNobles(s);
    }
    default:
      return fail('Choose: take gems, swap gems, hold a card, or buy a card.');
  }
  s.passes = 0;
  if (tokenCount(p) > MAX_TOKENS) {
    s.phase = 'discard';
    return ok(s);
  }
  return resolveNobles(s);
}

function doDiscard(s, p, seat, a) {
  if (a.type !== 'discard' || !a.tokens || typeof a.tokens !== 'object') return fail('You must return tokens down to 10.');
  if ((a.tokens.y || 0) > 0) return fail('Gold tokens cannot be returned.');
  const need = tokenCount(p) - MAX_TOKENS;
  let sum = 0;
  for (const g of GEMS) {
    const n = a.tokens[g] || 0;
    if (!isInt(n, 0, p.tokens[g])) return fail('You do not have those tokens.');
    sum += n;
  }
  if (sum !== need) return fail(`Return exactly ${need} token${need === 1 ? '' : 's'}.`);
  for (const g of GEMS) {
    const n = a.tokens[g] || 0;
    p.tokens[g] -= n;
    s.bank[g] += n;
  }
  s.lastEvent = { player: seat, type: 'discard', tokens: a.tokens };
  return resolveNobles(s);
}

function doNoble(s, p, seat, a) {
  if (a.type !== 'chooseNoble' || !s.pendingNobles.includes(a.nobleId)) return fail('Choose one of the nobles offered.');
  awardNoble(s, p, a.nobleId, seat);
  return ok(endTurn(s));
}

function awardNoble(s, p, id, seat) {
  const i = s.nobles.findIndex((n) => n.id === id);
  p.nobles.push(s.nobles.splice(i, 1)[0]);
  if (!s.lastEvent) s.lastEvent = { player: seat, type: 'noble' };
  s.lastEvent.noble = id;
}

function resolveNobles(s) {
  const p = s.players[s.current];
  const d = discounts(p);
  const eligible = s.nobles.filter((n) => COLORS.every((c) => (n.req[c] || 0) <= d[c]));
  if (eligible.length === 0) return ok(endTurn(s));
  if (eligible.length === 1) {
    awardNoble(s, p, eligible[0].id, s.current);
    return ok(endTurn(s));
  }
  s.phase = 'noble';
  s.pendingNobles = eligible.map((n) => n.id);
  return ok(s);
}

function endTurn(s) {
  const p = s.players[s.current];
  if (score(p) >= WIN_POINTS) s.finalRound = true;
  s.pendingNobles = [];
  if (s.passes >= s.numPlayers) {
    s.endedByStalemate = true;
    finishGame(s);
    return s;
  }
  if (s.current === s.numPlayers - 1 && s.finalRound) {
    finishGame(s);
    return s;
  }
  s.current = (s.current + 1) % s.numPlayers;
  if (s.current === 0) s.round++;
  s.phase = 'action';
  return s;
}

function finishGame(s) {
  s.phase = 'over';
  const scores = s.players.map(score);
  const best = Math.max(...scores);
  let winners = s.players.map((_, i) => i).filter((i) => scores[i] === best);
  const fewest = Math.min(...winners.map((i) => s.players[i].cards.length));
  winners = winners.filter((i) => s.players[i].cards.length === fewest);
  s.winners = winners; // more than one entry means a shared win
}

/* ---------- what each player is allowed to see ---------- */

/**
 * viewFor(state, seat): a copy safe to send to that player.
 * - deck contents are replaced by counts
 * - held cards stay visible to everyone (house rule)
 * - the seed is removed
 */
export function viewFor(state, seat) {
  const v = clone(state);
  v.decks = state.decks.map((d) => d.length);
  delete v.seed;
  v.you = seat;
  return v;
}
