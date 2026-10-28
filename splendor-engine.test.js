// Run with:  node --test
// (the project's package.json must contain  "type": "module")
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from './splendor-engine.js';

const setup = E.setupFor;
const totalTokens = (s) => E.GEMS.reduce((a, g) => a + s.bank[g] + s.players.reduce((b, p) => b + p.tokens[g], 0), 0);
const expectedTotal = (n) => setup(n).gemsEach * 5 + setup(n).gold;
const must = (r) => {
  assert.ok(r.ok, r.error);
  return r.state;
};
const names = (n) => Array.from({ length: n }, (_, i) => 'P' + i);
const noTokens = () => ({ w: 0, u: 0, g: 0, r: 0, k: 0, y: 0 });

test('setup is scaled for 2, 3 and 4 players', () => {
  assert.deepEqual(setup(2), { gemsEach: 4, gold: 3, nobles: 3, openPerTier: 4, deckTotals: [20, 15, 10] });
  assert.deepEqual(setup(3), { gemsEach: 5, gold: 4, nobles: 4, openPerTier: 4, deckTotals: [30, 23, 15] });
  assert.deepEqual(setup(4), { gemsEach: 7, gold: 5, nobles: 5, openPerTier: 4, deckTotals: [40, 30, 20] });
  for (const n of [2, 3, 4]) {
    const s = E.createGame(names(n), 7);
    assert.equal(totalTokens(s), expectedTotal(n));
    assert.equal(s.bank.w, setup(n).gemsEach);
    assert.equal(s.bank.y, setup(n).gold);
    assert.equal(s.nobles.length, n + 1);
    s.board.forEach((row) => assert.equal(row.length, 4));
    s.decks.forEach((d, t) => assert.equal(d.length + 4, setup(n).deckTotals[t]));
    const ids = [...s.board.flat(), ...s.decks.flat()].map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(s.current, 0);
    assert.equal(s.phase, 'action');
  }
});

test('full 4-player deck has the 40/30/20 split, 8/6/4 cards per colour, original-style prices', () => {
  const s = E.createGame(names(4), 3);
  const all = [[], [], []];
  [...s.board.flat(), ...s.decks.flat()].forEach((c) => all[c.tier].push(c));
  assert.deepEqual(all.map((a) => a.length), [40, 30, 20]);
  for (const c of E.COLORS) all.forEach((a, t) => assert.equal(a.filter((x) => x.color === c).length, [8, 6, 4][t]));
  const t3 = all[2];
  assert.ok(t3.some((c) => c.points === 5 && Object.values(c.cost).includes(7)));
  assert.ok(t3.every((c) => c.points >= 3));
  assert.ok(all[0].filter((c) => c.points === 1).length === 5);
  all.flat().forEach((c) => assert.ok(!(c.color in c.cost)));
});

test('same seed gives the same game', () => {
  assert.deepEqual(E.createGame(['a', 'b'], 99), E.createGame(['a', 'b'], 99));
});

test('taking gems: 3 different, 1, or 2 of one colour; never gold', () => {
  let s = E.createGame(['a', 'b'], 1);
  assert.equal(E.applyAction(s, 1, { type: 'takeGems', colors: ['w'] }).ok, false); // not your turn
  assert.equal(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'w', 'u'] }).ok, false);
  assert.ok(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'u'] }).ok); // 2 different gems are allowed
  assert.equal(E.applyAction(s, 0, { type: 'takeGems', colors: ['y'] }).ok, false);
  assert.equal(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'u', 'y'] }).ok, false);
  assert.equal(E.applyAction(s, 0, { type: 'buy', tier: 0, index: 0 }).ok, false); // cannot afford
  assert.equal(E.applyAction(s, 0, { type: 'pass' }).ok, false); // moves exist
  const three = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'u', 'g'] }));
  assert.equal(three.current, 1);
  assert.equal(three.players[0].tokens.g, 1);
  const one = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w'] }));
  assert.equal(one.players[0].tokens.w, 1);
  assert.equal(one.bank.w, 3);
});

test('two of one colour needs 4 in the bank', () => {
  let s = E.createGame(['a', 'b'], 1);
  s = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'w'] }));
  assert.equal(E.applyAction(s, 1, { type: 'takeGems', colors: ['w', 'w'] }).ok, false); // only 2 left
  must(E.applyAction(s, 1, { type: 'takeGems', colors: ['w'] }));
});

test('fewer than 3 colours left: take what is there', () => {
  const s = E.createGame(['a', 'b'], 1);
  s.bank = { w: 1, u: 2, g: 0, r: 0, k: 0, y: 3 };
  assert.equal(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'u', 'g'] }).ok, false);
  const t = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'u'] }));
  assert.equal(t.players[0].tokens.u, 1);
});

test('swap with the bank: same colour only, same number back, any token count, never gold', () => {
  const s = E.createGame(['a', 'b'], 1);
  s.players[0].tokens = { ...noTokens(), w: 2, u: 1, r: 1 };
  s.bank.w = 2;
  s.bank.u = 3;
  s.bank.r = 3;
  const sw = (take, give) => E.applyAction(s, 0, { type: 'swap', take, give });
  const t = must(sw(['g'], ['w']));
  assert.equal(t.players[0].tokens.g, 1);
  assert.equal(t.players[0].tokens.w, 1);
  assert.equal(t.bank.g, 3);
  assert.equal(t.bank.w, 3);
  assert.equal(t.current, 1); // a swap uses the whole turn
  assert.equal(E.tokenCount(t.players[0]), 4);
  assert.equal(sw(['r'], ['r']).ok, false); // cannot give back the colour taken
  assert.equal(sw(['g'], ['y']).ok, false); // gold cannot be given
  assert.equal(sw(['y'], ['w']).ok, false); // gold cannot be taken
  assert.equal(sw(['g'], ['w', 'u']).ok, false); // must give back same number
  assert.equal(sw(['g', 'u'], ['w', 'w']).ok, false); // two must be the same colour
  assert.equal(sw(['g'], ['k']).ok, false); // does not have that gem
  assert.equal(sw(['g', 'g'], ['w', 'u']).ok, true); // bank g is 4 -> allowed
  assert.equal(sw(['u', 'u'], ['w', 'w']).ok, false); // bank u is 3 -> not allowed
  const two = must(sw(['g', 'g'], ['w', 'w']));
  assert.equal(two.players[0].tokens.g, 2);
  assert.equal(two.players[0].tokens.w, 0);
  assert.equal(E.applyAction(s, 1, { type: 'swap', take: ['g'], give: ['w'] }).ok, false); // not your turn
});

test('input state is never mutated', () => {
  const s = E.createGame(['a', 'b'], 1);
  const before = JSON.stringify(s);
  E.applyAction(s, 0, { type: 'takeGems', colors: ['w'] });
  E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'u', 'g'] });
  assert.equal(JSON.stringify(s), before);
});

test('reserving gives gold, refills the board, hides deck reserve', () => {
  let s = E.createGame(['a', 'b'], 1);
  const card = s.board[1][2];
  s = must(E.applyAction(s, 0, { type: 'reserve', tier: 1, index: 2 }));
  assert.equal(s.players[0].reserved[0].id, card.id);
  assert.equal(s.players[0].tokens.y, 1);
  assert.ok(s.board[1][2] && s.board[1][2].id !== card.id);
  s = must(E.applyAction(s, 1, { type: 'reserve', tier: 0, fromDeck: true }));
  assert.equal(s.decks[0].length, setup(2).deckTotals[0] - 4 - 1);
  const view = E.viewFor(s, 0);
  assert.ok(view.players[1].reserved[0].id); // held cards are visible to everyone
  assert.equal(view.players[0].reserved[0].id, card.id);
  assert.equal(typeof view.decks[0], 'number');
  assert.equal(view.seed, undefined);
});

test('buying uses discounts and gold, returns tokens to the bank', () => {
  let s = E.createGame(['a', 'b'], 1);
  const card = { id: 'x', tier: 0, color: 'g', points: 1, cost: { w: 2, u: 1 } };
  s.board[0][0] = card;
  s.players[0].tokens = { w: 1, u: 0, g: 0, r: 0, k: 0, y: 2 };
  s.bank.w = 3;
  s.bank.y = 1;
  const before = totalTokens(s);
  s = must(E.applyAction(s, 0, { type: 'buy', tier: 0, index: 0 }));
  assert.equal(s.players[0].cards[0].id, 'x');
  assert.equal(totalTokens(s), before);
  assert.equal(s.players[0].tokens.y, 0);
  assert.equal(E.discounts(s.players[0]).g, 1);
});

test('discard phase when over 10 tokens; gold cannot be returned', () => {
  let s = E.createGame(['a', 'b'], 1);
  s.players[0].tokens = { ...noTokens(), r: 5, k: 4, y: 1 }; // 10 tokens
  s.bank.r = 0;
  s.bank.k = 0;
  s = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w', 'w'] })); // 12 tokens
  assert.equal(s.phase, 'discard');
  assert.equal(s.current, 0);
  assert.equal(E.applyAction(s, 0, { type: 'discard', tokens: { r: 1 } }).ok, false); // need 2
  assert.equal(E.applyAction(s, 0, { type: 'discard', tokens: { y: 1, r: 1 } }).ok, false); // gold cannot be returned
  assert.equal(E.applyAction(s, 0, { type: 'discard', tokens: { u: 2 } }).ok, false); // does not have
  s = must(E.applyAction(s, 0, { type: 'discard', tokens: { r: 2 } }));
  assert.equal(E.tokenCount(s.players[0]), 10);
  assert.equal(s.current, 1);
  assert.equal(s.phase, 'action');
});

test('noble choice when two qualify, automatic when one qualifies', () => {
  let s = E.createGame(['a', 'b'], 1);
  const mk = (color, i) => ({ id: 'c' + color + i, tier: 0, color, points: 0, cost: {} });
  s.players[0].cards = [...[0, 1, 2].map((i) => mk('w', i)), ...[0, 1, 2].map((i) => mk('u', i))];
  s.nobles = [
    { id: 'A', points: 3, req: { w: 3, u: 3 } },
    { id: 'B', points: 3, req: { w: 3, u: 3 } },
  ];
  let t = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w'] }));
  assert.equal(t.phase, 'noble');
  assert.equal(t.current, 0);
  assert.equal(E.applyAction(t, 0, { type: 'chooseNoble', nobleId: 'Z' }).ok, false);
  t = must(E.applyAction(t, 0, { type: 'chooseNoble', nobleId: 'B' }));
  assert.equal(t.players[0].nobles[0].id, 'B');
  assert.equal(t.nobles.length, 1);
  assert.equal(t.current, 1);
  s.nobles = [{ id: 'A', points: 3, req: { w: 3, u: 3 } }];
  t = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w'] }));
  assert.equal(t.players[0].nobles.length, 1);
  assert.equal(t.current, 1);
});

test('game ends after the round finishes, ties go to fewest cards', () => {
  let s = E.createGame(['a', 'b', 'c'], 1);
  s.players[0].cards = [{ id: 'big', tier: 2, color: 'w', points: 15, cost: {} }];
  s.players[1].cards = [{ id: 'm1', tier: 2, color: 'w', points: 7, cost: {} }, { id: 'm2', tier: 2, color: 'u', points: 8, cost: {} }];
  s = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w'] }));
  assert.equal(s.finalRound, true);
  assert.equal(s.phase, 'action');
  s = must(E.applyAction(s, 1, { type: 'takeGems', colors: ['r'] }));
  assert.equal(s.phase, 'action'); // player 2 still to play
  s = must(E.applyAction(s, 2, { type: 'takeGems', colors: ['k'] }));
  assert.equal(s.phase, 'over');
  assert.deepEqual(s.winners, [0]); // 15 vs 15, player 0 has fewer cards
  assert.equal(s.endedByStalemate, false);
  assert.equal(E.applyAction(s, 0, { type: 'takeGems', colors: ['w'] }).ok, false);
});

test('pass is only allowed when there is no other move', () => {
  const s = E.createGame(['a', 'b'], 1);
  s.bank = { w: 0, u: 0, g: 0, r: 0, k: 0, y: 0 };
  s.players[0].reserved = [s.board[0][0], s.board[0][1], s.board[0][2]];
  assert.deepEqual(E.getLegalActions(s), [{ type: 'pass' }]);
  const t = must(E.applyAction(s, 0, { type: 'pass' }));
  assert.equal(t.current, 1);
});

test('stalemate: if every player passes in a row the game ends, highest score wins', () => {
  let s = E.createGame(['a', 'b'], 1);
  s.bank = { w: 0, u: 0, g: 0, r: 0, k: 0, y: 0 };
  s.players[0].reserved = [s.board[0][0], s.board[0][1], s.board[0][2]];
  s.players[1].reserved = [s.board[1][0], s.board[1][1], s.board[1][2]];
  s.players[1].cards = [{ id: 'p', tier: 0, color: 'w', points: 1, cost: {} }];
  s = must(E.applyAction(s, 0, { type: 'pass' }));
  assert.equal(s.phase, 'action');
  s = must(E.applyAction(s, 1, { type: 'pass' }));
  assert.equal(s.phase, 'over');
  assert.equal(s.endedByStalemate, true);
  assert.deepEqual(s.winners, [1]);
});

test('a real move resets the pass counter', () => {
  let s = E.createGame(['a', 'b', 'c'], 1);
  s.passes = 2;
  s = must(E.applyAction(s, 0, { type: 'takeGems', colors: ['w'] }));
  assert.equal(s.passes, 0);
});

/* ---- simulated games with a simple bot: must finish, never lose tokens,
        and every action the engine calls legal must be accepted ---- */

function makeRand(seed) {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function botMove(s, rand) {
  const seat = s.current;
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  if (s.phase === 'discard') {
    const p = s.players[seat];
    let need = E.tokenCount(p) - E.MAX_TOKENS;
    const tokens = {};
    for (const g of E.COLORS) {
      const n = Math.min(p.tokens[g], need);
      if (n) {
        tokens[g] = n;
        need -= n;
      }
    }
    return { type: 'discard', tokens };
  }
  if (s.phase === 'noble') return { type: 'chooseNoble', nobleId: s.pendingNobles[0] };
  const acts = E.getLegalActions(s);
  const buys = acts.filter((a) => a.type === 'buy');
  if (buys.length) return pick(buys);
  const r = rand();
  const takes = acts.filter((a) => a.type === 'takeGems');
  const swaps = acts.filter((a) => a.type === 'swap');
  if (swaps.length && r < 0.15) return pick(swaps);
  if (takes.length && r < 0.85) return pick(takes);
  return pick(acts);
}

test('simulated games finish and conserve tokens (2, 3, 4 players)', () => {
  let stalemates = 0;
  for (const n of [2, 3, 4]) {
    for (let seed = 1; seed <= 15; seed++) {
      const rand = makeRand(seed * 31 + n);
      let s = E.createGame(names(n), seed);
      let steps = 0;
      while (s.phase !== 'over' && steps < 6000) {
        // every action listed as legal must be accepted
        if (s.phase === 'action' && steps % 7 === 0) {
          for (const a of E.getLegalActions(s).slice(0, 40)) {
            const r = E.applyAction(s, s.current, a);
            assert.ok(r.ok, `n=${n} seed=${seed}: legal action rejected ${JSON.stringify(a)} -> ${r.error}`);
          }
        }
        const a = botMove(s, rand);
        const r = E.applyAction(s, s.current, a);
        assert.ok(r.ok, `n=${n} seed=${seed} step=${steps}: ${r.error} ${JSON.stringify(a)}`);
        s = r.state;
        assert.equal(totalTokens(s), expectedTotal(n));
        s.players.forEach((p) => {
          assert.ok(p.reserved.length <= 3);
          E.GEMS.forEach((g) => assert.ok(p.tokens[g] >= 0 && s.bank[g] >= 0));
        });
        steps++;
      }
      assert.equal(s.phase, 'over', `n=${n} seed=${seed} did not finish`);
      assert.ok(s.winners.length >= 1);
      if (s.endedByStalemate) stalemates++;
    }
  }
  assert.ok(stalemates <= 45);
});
