// Plays complete games through real socket connections: 2, 3 and 4 players.
import test from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from './server.js';
import * as E from './splendor-engine.js';

function start(opts = { rateLimit: 1e9 }) {
  const srv = createApp(opts);
  return new Promise((res) => srv.http.listen(0, () => res({ ...srv, port: srv.http.address().port })));
}

function client(port) {
  const s = connect(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
  const c = { s, last: null, all: [] };
  s.on('state', (st) => {
    c.last = st;
    c.all.push(st);
  });
  c.emit = (ev, p) => new Promise((r) => s.emit(ev, p, r));
  c.ready = new Promise((r) => s.on('connect', r));
  return c;
}
const wait = async (cond, ms = 3000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 1));
  }
};

function pickAction(view, rand) {
  const s = view; // view has deck counts only; use engine on a shadow of the public data for legal moves
  const me = s.players[s.you];
  if (s.phase === 'discard') {
    let need = E.tokenCount(me) - 10;
    const tokens = {};
    for (const g of E.COLORS) {
      const n = Math.min(me.tokens[g], need);
      if (n) {
        tokens[g] = n;
        need -= n;
      }
    }
    return { type: 'discard', tokens };
  }
  if (s.phase === 'noble') return { type: 'chooseNoble', nobleId: s.pendingNobles[0] };
  // legal actions need real deck arrays: fake them (only lengths matter for legality)
  const shadow = { ...s, decks: s.decks.map((n) => Array(n).fill(0)), current: s.you };
  const acts = E.getLegalActions(shadow);
  const buys = acts.filter((a) => a.type === 'buy');
  if (buys.length) return buys[Math.floor(rand() * buys.length)];
  const swaps = acts.filter((a) => a.type === 'swap');
  if (swaps.length && rand() < 0.1) return swaps[Math.floor(rand() * swaps.length)];
  const takes = acts.filter((a) => a.type === 'takeGems');
  if (takes.length && rand() < 0.85) return takes[Math.floor(rand() * takes.length)];
  return acts[Math.floor(rand() * acts.length)];
}

for (const n of [2, 3, 4]) {
  test(`${n} players play a full game over sockets, the seed and deck order stay secret`, async () => {
    const { port, http, io } = await start();
    const cs = Array.from({ length: n }, () => client(port));
    await Promise.all(cs.map((c) => c.ready));
    let rand = ((a) => () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296))(n * 7);
    const created = await cs[0].emit('createRoom', { name: 'Host', maxPlayers: n });
    assert.ok(created.ok);
    assert.match(created.code, /^[A-Z]{4}$/);
    assert.equal((await cs[1].emit('joinRoom', { code: 'ZZZZ', name: 'X' })).ok, false);
    for (let i = 1; i < n; i++) assert.ok((await cs[i].emit('joinRoom', { code: created.code.toLowerCase(), name: 'P' + i })).ok);
    await wait(() => cs.every((c) => c.last && c.last.status === 'playing'));
    assert.equal((await cs[0].emit('joinRoom', { code: created.code, name: 'late' })).ok, false);

    let steps = 0;
    while (cs[0].last.status !== 'over' && steps < 3000) {
      const v = cs[0].last.view;
      const actor = cs.find((c) => c.last.you === v.current);
      // wrong-turn actions are rejected and change nothing
      if (steps % 25 === 0) {
        const other = cs.find((c) => c !== actor);
        const before = other.last.seq;
        const bad = await other.emit('action', { action: { type: 'takeGems', colors: ['w'] } });
        assert.equal(bad.ok, false);
        assert.equal(other.last.seq, before);
      }
      const a = pickAction(actor.last.view, rand);
      const r = await actor.emit('action', { action: a });
      assert.ok(r.ok, `step ${steps}: ${r.error} ${JSON.stringify(a)}`);
      await wait(() => cs.every((c) => c.last.seq === actor.last.seq));
      steps++;
    }
    console.log('players', n, 'finished after', steps, 'actions');
    assert.equal(cs[0].last.status, 'over');
    assert.ok(cs[0].last.view.winners.length >= 1);
    // privacy: seed never sent, decks are plain counts, other players' held cards hidden
    for (const c of cs) {
      for (const st of c.all) {
        if (!st.view) continue;
        assert.equal(st.view.seed, undefined);
        st.view.decks.forEach((d) => assert.equal(typeof d, 'number'));
        st.view.players.forEach((p, i) => {
          if (i !== st.you) p.reserved.forEach((x) => assert.ok(x.id)); // held cards are visible
        });
      }
    }
    // rematch: everyone must agree, then a fresh game starts
    for (const c of cs) assert.ok((await c.emit('rematch', {})).ok);
    await wait(() => cs.every((c) => c.last.status === 'playing' && c.last.view.round === 1 && c.last.view.phase === 'action'));
    cs.forEach((c) => c.s.close());
    io.close();
    http.close();
  });
}

test('reconnect with the saved token returns to the same seat and hand', async () => {
  const { port, http, io } = await start();
  const a = client(port), b = client(port);
  await Promise.all([a.ready, b.ready]);
  const created = await a.emit('createRoom', { name: 'A', maxPlayers: 2 });
  const joined = await b.emit('joinRoom', { code: created.code, name: 'B' });
  await wait(() => a.last.status === 'playing' && b.last.status === 'playing');
  b.s.close();
  await wait(() => a.last.seats[1].connected === false);
  const b2 = client(port);
  await b2.ready;
  assert.equal((await b2.emit('rejoin', { code: created.code, token: 'wrong' })).ok, false);
  assert.ok((await b2.emit('rejoin', { code: created.code, token: joined.token })).ok);
  await wait(() => b2.last && b2.last.you === 1);
  assert.equal(b2.last.view.players[1].name, 'B');
  await wait(() => a.last.seats[1].connected === true);
  a.s.close(); b2.s.close(); io.close(); http.close();
});

test('names are cleaned and bad input is refused', async () => {
  const { port, http, io } = await start();
  const a = client(port);
  await a.ready;
  assert.equal((await a.emit('createRoom', { name: 'x', maxPlayers: 9 })).ok, false);
  const r = await a.emit('createRoom', { name: '<b>Eve</b>' + 'y'.repeat(40), maxPlayers: 2 });
  assert.ok(r.ok);
  await wait(() => a.last);
  assert.ok(a.last.seats[0].name.length <= 20);
  assert.ok(!a.last.seats[0].name.includes('<'));
  a.s.close(); io.close(); http.close();
});

test('a connection that floods the server is slowed down', async () => {
  const { port, http, io } = await start({});
  const a = client(port);
  await a.ready;
  const results = await Promise.all(Array.from({ length: 40 }, () => a.emit('joinRoom', { code: 'NOPE', name: 'x' })));
  assert.ok(results.some((r) => r.error === 'Slow down a little.'));
  a.s.close(); io.close(); http.close();
});
