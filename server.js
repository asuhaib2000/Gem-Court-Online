// Gem Court online server: rooms + real-time play for 2 to 4 players.
// The SERVER owns the game. Browsers only send an action and draw the state they get back.
import express from 'express';
import { createServer as createHttp } from 'http';
import { Server } from 'socket.io';
import { randomUUID, randomInt } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as E from './splendor-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LETTERS = 'ABCDEFGHJKMNPRSTUVWXYZ'; // no I, L, O, Q (look-alikes)
const IDLE_MS = 24 * 60 * 60 * 1000;

const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Player';

export function createApp(opts = {}) {
  const LIMIT = opts.rateLimit ?? 15; // messages per second per connection
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/splendor-engine.js', (req, res) => res.type('text/javascript').sendFile(path.join(__dirname, 'splendor-engine.js')));
  app.get('/healthz', (req, res) => res.send('ok'));
  const http = createHttp(app);
  const io = new Server(http);
  const rooms = new Map();

  const newCode = () => {
    for (;;) {
      const c = Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
      if (!rooms.has(c)) return c;
    }
  };

  function publish(room) {
    room.seats.forEach((seat, i) => {
      if (!seat.sid) return;
      io.to(seat.sid).emit('state', {
        code: room.code,
        status: room.status,
        max: room.max,
        seats: room.seats.map((s) => ({ name: s.name, connected: !!s.sid })),
        you: i,
        host: seat.host === true,
        seq: room.seq,
        view: room.state ? E.viewFor(room.state, i) : null,
        rematch: room.seats.map((s) => room.rematch.has(s.token)),
      });
    });
  }

  function startGame(room) {
    room.state = E.createGame(room.seats.map((s) => s.name), randomInt(1, 2 ** 31));
    room.status = 'playing';
    room.rematch = new Set();
    room.seq++;
  }

  io.on('connection', (socket) => {
    const bucket = { n: 0, t: Date.now() };
    const on = (event, fn) =>
      socket.on(event, (payload, cb) => {
        if (typeof cb !== 'function') cb = () => {};
        const now = Date.now();
        if (now - bucket.t > 1000) {
          bucket.t = now;
          bucket.n = 0;
        }
        if (++bucket.n > LIMIT) return cb({ ok: false, error: 'Slow down a little.' });
        try {
          fn(payload && typeof payload === 'object' ? payload : {}, cb);
        } catch (e) {
          console.error(e);
          cb({ ok: false, error: 'Something went wrong on the server.' });
        }
      });
    const mine = () => {
      for (const room of rooms.values()) {
        const i = room.seats.findIndex((s) => s.sid === socket.id);
        if (i >= 0) return { room, seat: i };
      }
      return null;
    };

    on('createRoom', (p, cb) => {
      const max = Number(p.maxPlayers);
      if (!Number.isInteger(max) || max < 2 || max > 4) return cb({ ok: false, error: 'Choose 2, 3 or 4 players.' });
      const token = randomUUID();
      const room = {
        code: newCode(), max, status: 'waiting', state: null, seq: 0, rematch: new Set(), touched: Date.now(),
        seats: [{ name: cleanName(p.name), token, sid: socket.id, host: true }],
      };
      rooms.set(room.code, room);
      cb({ ok: true, code: room.code, seat: 0, token });
      publish(room);
    });

    on('joinRoom', (p, cb) => {
      const room = rooms.get(String(p.code || '').toUpperCase().trim());
      if (!room) return cb({ ok: false, error: 'Room not found. Check the code.' });
      if (room.status !== 'waiting') return cb({ ok: false, error: 'That game has already started.' });
      if (room.seats.length >= room.max) return cb({ ok: false, error: 'Room is full.' });
      const token = randomUUID();
      room.seats.push({ name: cleanName(p.name), token, sid: socket.id, host: false });
      room.touched = Date.now();
      if (room.seats.length === room.max) startGame(room);
      cb({ ok: true, code: room.code, seat: room.seats.length - 1, token });
      publish(room);
    });

    on('rejoin', (p, cb) => {
      const room = rooms.get(String(p.code || '').toUpperCase().trim());
      const seat = room ? room.seats.findIndex((s) => s.token === p.token) : -1;
      if (!room || seat < 0) return cb({ ok: false, error: 'That game is no longer available.' });
      room.seats[seat].sid = socket.id;
      room.touched = Date.now();
      cb({ ok: true, seat });
      publish(room);
    });

    on('start', (p, cb) => {
      const m = mine();
      if (!m) return cb({ ok: false, error: 'You are not in a room.' });
      const { room, seat } = m;
      if (!room.seats[seat].host) return cb({ ok: false, error: 'Only the host can start the game.' });
      if (room.status !== 'waiting' || room.seats.length < 2) return cb({ ok: false, error: 'Need at least 2 players.' });
      startGame(room);
      room.touched = Date.now();
      cb({ ok: true });
      publish(room);
    });

    on('action', (p, cb) => {
      const m = mine();
      if (!m) return cb({ ok: false, error: 'You are not in a room.' });
      const { room, seat } = m;
      if (room.status !== 'playing') return cb({ ok: false, error: 'The game is not running.' });
      const r = E.applyAction(room.state, seat, p.action);
      if (!r.ok) return cb({ ok: false, error: r.error });
      room.state = r.state;
      room.seq++;
      room.touched = Date.now();
      if (room.state.phase === 'over') room.status = 'over';
      cb({ ok: true });
      publish(room);
    });

    on('rematch', (p, cb) => {
      const m = mine();
      if (!m) return cb({ ok: false, error: 'You are not in a room.' });
      const { room, seat } = m;
      if (room.status !== 'over') return cb({ ok: false, error: 'The game is not finished.' });
      room.rematch.add(room.seats[seat].token);
      if (room.seats.every((s) => room.rematch.has(s.token))) {
        room.seats.push(room.seats.shift()); // someone else goes first this time
        startGame(room);
      }
      room.touched = Date.now();
      cb({ ok: true });
      publish(room);
    });

    socket.on('disconnect', () => {
      for (const room of rooms.values()) {
        room.seats.forEach((s) => {
          if (s.sid === socket.id) s.sid = null;
        });
        publish(room);
      }
    });
  });

  const timer = setInterval(() => {
    for (const [code, room] of rooms) if (Date.now() - room.touched > IDLE_MS) rooms.delete(code);
  }, 10 * 60 * 1000);
  timer.unref();

  return { app, http, io, rooms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { http } = createApp();
  const port = process.env.PORT || 3000;
  http.listen(port, () => console.log(`Gem Court is running on port ${port}`));
}
