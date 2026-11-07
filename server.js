/**
 * IMPOSTER — real-time multiplayer word party game
 * Stack: Node.js + Express + Socket.io
 *
 * The server is the single source of truth. Clients never receive the secret
 * word or other players' roles unless they are allowed to see them: every
 * broadcast builds a PERSONALISED view per player (see buildView).
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok')); // handy for hosting health checks

const LIMITS = { maxPlayers: 12, minPlayers: 3, discussionMs: 90_000, votingMs: 45_000, revealMs: 7_000, guessMs: 40_000, maxRounds: 3 };
const rooms = new Map(); // code -> room

/* --------------------------------- Helpers -------------------------------- */
const rint = (n) => crypto.randomInt(n);
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = rint(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — easy to read aloud
  let code;
  do { code = Array.from({ length: 4 }, () => chars[rint(chars.length)]).join(''); } while (rooms.has(code));
  return code;
}

function newRoom(code) {
  return {
    code, players: [], phase: 'lobby',
    config: { secretWord: '', hintWord: '', imposters: 1, clueTime: 30 },
    word: '', hint: '', round: 0, order: [], turnIdx: 0,
    timeout: null, timerEnd: 0, log: [], chat: [], votes: {}, reveal: null, guessId: null, result: null, cleanup: null
  };
}

const alive = (room) => room.players.filter((p) => p.alive);
const byId = (room, id) => room.players.find((p) => p.id === id);
const host = (room) => room.players.find((p) => p.isHost);

/** Single timer per room; replaces any previous one. */
function setTimer(room, ms, cb) {
  clearTimeout(room.timeout);
  room.timerEnd = Date.now() + ms;
  room.timeout = setTimeout(cb, ms);
}
function clearTimer(room) { clearTimeout(room.timeout); room.timeout = null; room.timerEnd = 0; }

/* ---------------------- Personalised state broadcasting -------------------- */
function buildView(room, me) {
  const showRoles = room.phase === 'results';
  return {
    code: room.code, phase: room.phase, round: room.round,
    // The secret + hint words are only echoed back to the host who typed them
    config: { imposters: room.config.imposters, clueTime: room.config.clueTime,
      secretWord: me.isHost ? room.config.secretWord : '', hintWord: me.isHost ? room.config.hintWord : '' },
    you: me.id,
    myRole: room.phase === 'lobby' ? null : me.role,
    myWord: me.role === 'civilian' ? room.word : null,
    myHint: me.role === 'imposter' ? room.hint : null, // the imposter's only clue
    players: room.players.map((p) => ({
      id: p.id, name: p.name, isHost: p.isHost, connected: p.connected, alive: p.alive,
      // Roles are only public for eliminated players and at game end.
      role: (!p.alive || showRoles) && room.phase !== 'lobby' ? p.role : null,
      voted: room.phase === 'voting' ? p.id in room.votes : false
    })),
    turnId: room.phase === 'clue' ? room.order[room.turnIdx] : null,
    order: room.order,
    timeLeft: room.timerEnd ? Math.max(0, room.timerEnd - Date.now()) : 0,
    log: room.log, chat: room.chat,
    myVote: room.votes[me.id] ?? null,
    reveal: room.reveal, guessId: room.guessId, result: room.result
  };
}
function broadcast(room) {
  for (const p of room.players) if (p.sid) io.to(p.sid).emit('state', buildView(room, p));
}

/* ------------------------------- Game flow -------------------------------- */
function startGame(room) {
  const { config } = room;
  // Both words come straight from the host (no word packs)
  room.word = clean(config.secretWord, 30);
  room.hint = clean(config.hintWord, 30);

  // Secure shuffle -> first N players become imposters
  let shuffled = shuffle(room.players);
  // The host typed the secret word, so the host is never the imposter (fairness)
  shuffled = [...shuffled.filter((p) => !p.isHost), ...shuffled.filter((p) => p.isHost)];
  shuffled.forEach((p, i) => { p.role = i < config.imposters ? 'imposter' : 'civilian'; p.alive = true; });
  room.round = 0; room.log = []; room.chat = []; room.result = null; room.reveal = null;
  room.baseOrder = shuffle(room.players).map((p) => p.id); // strict turn order for the whole game
  startClueRound(room);
}

function startClueRound(room) {
  room.round += 1;
  room.phase = 'clue';
  room.votes = {}; room.reveal = null; room.guessId = null;
  room.order = room.baseOrder.filter((id) => byId(room, id)?.alive);
  room.turnIdx = -1;
  room.log.push({ system: true, text: `Round ${room.round} — give a one-word clue` });
  nextTurn(room);
}

function nextTurn(room) {
  room.turnIdx += 1;
  if (room.turnIdx >= room.order.length) return startDiscussion(room);
  const p = byId(room, room.order[room.turnIdx]);
  if (!p || !p.connected) { // skip people who left
    room.log.push({ system: true, text: `${p ? p.name : 'A player'} is away — skipped` });
    return nextTurn(room);
  }
  setTimer(room, room.config.clueTime * 1000, () => {
    room.log.push({ name: p.name, id: p.id, clue: '—', missed: true, round: room.round });
    nextTurn(room);
  });
  broadcast(room);
}

function startDiscussion(room) {
  room.phase = 'discussion';
  setTimer(room, LIMITS.discussionMs, () => startVoting(room));
  broadcast(room);
}

function startVoting(room) {
  room.phase = 'voting'; room.votes = {};
  setTimer(room, LIMITS.votingMs, () => tally(room));
  broadcast(room);
}

function tally(room) {
  const counts = {};
  for (const target of Object.values(room.votes)) counts[target] = (counts[target] || 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  const tie = entries.length > 1 && entries[1][1] === top[1];
  let eliminated = null;
  if (top && !tie && top[0] !== 'skip') eliminated = byId(room, top[0]);

  if (eliminated) eliminated.alive = false;
  room.reveal = {
    counts, eliminatedId: eliminated?.id || null, name: eliminated?.name || null, role: eliminated?.role || null,
    text: eliminated ? `${eliminated.name} was voted out — they were ${eliminated.role === 'imposter' ? 'an IMPOSTER' : 'a civilian'}.` : (tie ? 'Tie vote — nobody is eliminated.' : 'Nobody was eliminated.')
  };
  room.phase = 'reveal';
  setTimer(room, LIMITS.revealMs, () => afterReveal(room));
  broadcast(room);
}

function afterReveal(room) {
  const out = byId(room, room.reveal.eliminatedId);
  if (out && out.role === 'imposter') return startGuess(room, out); // redemption chance
  continueOrEnd(room);
}

function continueOrEnd(room) {
  const imps = alive(room).filter((p) => p.role === 'imposter').length;
  const civs = alive(room).filter((p) => p.role === 'civilian').length;
  if (imps === 0) return endGame(room, 'civilians', 'All imposters were caught.');
  if (imps >= civs) return endGame(room, 'imposters', 'The imposters outnumber the civilians.');
  if (room.round >= LIMITS.maxRounds) return endGame(room, 'imposters', 'The imposters survived every round.');
  startClueRound(room);
}

function startGuess(room, imp) {
  room.phase = 'guess'; room.guessId = imp.id;
  setTimer(room, LIMITS.guessMs, () => resolveGuess(room, ''));
  broadcast(room);
}

function resolveGuess(room, text) {
  const imp = byId(room, room.guessId);
  const ok = norm(text) && norm(text) === norm(room.word);
  room.log.push({ system: true, text: `${imp.name} guessed "${clean(text, 30) || '(nothing)'}" — ${ok ? 'correct!' : 'wrong.'}` });
  if (ok) return endGame(room, 'imposters', `${imp.name} guessed the secret word and steals the win!`);
  continueOrEnd(room);
}

function endGame(room, winner, reason) {
  clearTimer(room);
  room.phase = 'results';
  room.result = { winner, reason, word: room.word, roles: room.players.map((p) => ({ id: p.id, name: p.name, role: p.role })) };
  broadcast(room);
}

function resetToLobby(room) {
  clearTimer(room);
  room.phase = 'lobby'; room.log = []; room.chat = []; room.votes = {}; room.reveal = null; room.result = null; room.round = 0;
  room.players.forEach((p) => { p.role = null; p.alive = true; });
  room.players = room.players.filter((p) => p.connected);
  if (!host(room) && room.players[0]) room.players[0].isHost = true;
  broadcast(room);
}

/** If someone drops mid-game, keep things moving. */
function handleMidGameLeave(room, p) {
  if (room.phase === 'clue' && room.order[room.turnIdx] === p.id) return nextTurn(room);
  if (room.phase === 'voting') {
    const voters = alive(room).filter((x) => x.connected);
    if (voters.every((x) => x.id in room.votes)) return tally(room);
  }
  const conn = alive(room).filter((x) => x.connected).length;
  if (['clue', 'discussion', 'voting'].includes(room.phase) && conn < 2) return endGame(room, 'none', 'Not enough players left.');
  broadcast(room);
}

/* --------------------------------- Sockets -------------------------------- */
io.on('connection', (socket) => {
  let room = null, me = null;

  const attach = (r, p) => { room = r; me = p; p.sid = socket.id; p.connected = true; socket.join(r.code); clearTimeout(r.cleanup); };
  const fail = (cb, error) => cb && cb({ ok: false, error });
  const isHost = () => room && me && me.isHost;

  socket.on('createRoom', ({ name } = {}, cb) => {
    name = clean(name, 16); if (!name) return fail(cb, 'Enter a username.');
    const r = newRoom(genCode()); rooms.set(r.code, r);
    const p = { id: crypto.randomUUID(), name, isHost: true, connected: true, alive: true, role: null };
    r.players.push(p); attach(r, p);
    cb && cb({ ok: true, code: r.code, pid: p.id }); broadcast(r);
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    code = clean(code, 4).toUpperCase(); name = clean(name, 16);
    const r = rooms.get(code);
    if (!name) return fail(cb, 'Enter a username.');
    if (!r) return fail(cb, 'Room not found. Check the code.');
    if (r.phase !== 'lobby') return fail(cb, 'That game has already started.');
    if (r.players.length >= LIMITS.maxPlayers) return fail(cb, 'Room is full.');
    if (r.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return fail(cb, 'That name is taken in this room.');
    const p = { id: crypto.randomUUID(), name, isHost: false, connected: true, alive: true, role: null };
    r.players.push(p); attach(r, p);
    cb && cb({ ok: true, code: r.code, pid: p.id }); broadcast(r);
  });

  // Reconnect after a refresh / dropped mobile connection
  socket.on('resume', ({ code, pid } = {}, cb) => {
    const r = rooms.get(String(code || '').toUpperCase());
    const p = r && r.players.find((x) => x.id === pid);
    if (!p) return fail(cb, 'expired');
    attach(r, p); cb && cb({ ok: true, code: r.code, pid: p.id }); broadcast(r);
  });

  socket.on('config', (patch = {}) => {
    if (!isHost() || room.phase !== 'lobby') return;
    const c = room.config;
    if (typeof patch.secretWord === 'string') c.secretWord = clean(patch.secretWord, 30);
    if (typeof patch.hintWord === 'string') c.hintWord = clean(patch.hintWord, 30);
    if ([1, 2].includes(patch.imposters)) c.imposters = patch.imposters;
    if ([15, 30, 45, 60].includes(patch.clueTime)) c.clueTime = patch.clueTime;
    broadcast(room);
  });

  socket.on('start', (_, cb) => {
    if (!isHost() || room.phase !== 'lobby') return;
    const n = room.players.filter((p) => p.connected).length;
    room.players = room.players.filter((p) => p.connected);
    const sw = clean(room.config.secretWord, 30), hw = clean(room.config.hintWord, 30);
    if (!sw || !hw) return fail(cb, 'Enter both the secret word and the imposter hint word.');
    if (norm(sw) === norm(hw)) return fail(cb, 'The hint word must be different from the secret word.');
    const need = room.config.imposters === 2 ? 5 : LIMITS.minPlayers;
    if (n < need) return fail(cb, `Need at least ${need} players for ${room.config.imposters} imposter${room.config.imposters > 1 ? 's' : ''}.`);
    startGame(room);
  });

  socket.on('clue', (text) => {
    if (!room || room.phase !== 'clue' || room.order[room.turnIdx] !== me.id) return;
    const word = clean(text, 24).split(/\s+/)[0];
    if (!word) return;
    room.log.push({ name: me.name, id: me.id, clue: word, round: room.round });
    nextTurn(room);
  });

  socket.on('chat', (text) => {
    if (!room || !['discussion', 'voting', 'clue'].includes(room.phase)) return;
    text = clean(text, 200); if (!text) return;
    room.chat.push({ name: me.name, id: me.id, text, dead: !me.alive });
    room.chat = room.chat.slice(-100);
    broadcast(room);
  });

  socket.on('skipDiscussion', () => { if (isHost() && room.phase === 'discussion') startVoting(room); });

  socket.on('vote', (target) => {
    if (!room || room.phase !== 'voting' || !me.alive) return;
    if (target !== 'skip' && !(byId(room, target)?.alive && target !== me.id)) return;
    room.votes[me.id] = target;
    const voters = alive(room).filter((p) => p.connected);
    if (voters.every((p) => p.id in room.votes)) return tally(room);
    broadcast(room);
  });

  socket.on('guess', (text) => {
    if (!room || room.phase !== 'guess' || room.guessId !== me.id) return;
    resolveGuess(room, text);
  });

  socket.on('playAgain', () => { if (isHost() && room.phase === 'results') resetToLobby(room); });

  socket.on('leave', () => { if (room) leave(true); });
  socket.on('disconnect', () => { if (room) leave(false); });

  function leave(explicit) {
    const r = room, p = me; room = null; me = null;
    socket.leave(r.code);
    p.connected = false; p.sid = null;
    if (r.phase === 'lobby') {
      // Grace period so a refresh doesn't kick someone out of the lobby
      setTimeout(() => {
        if (!p.connected && r.players.includes(p)) { r.players = r.players.filter((x) => x !== p); reassignHost(r); broadcast(r); }
      }, explicit ? 0 : 15_000);
    } else {
      reassignHost(r);
      if (r.phase !== 'results') handleMidGameLeave(r, p);
    }
    broadcast(r);
    if (!r.players.some((x) => x.connected)) { // empty room -> clean up after a while
      r.cleanup = setTimeout(() => { clearTimer(r); rooms.delete(r.code); }, 60_000);
    }
  }
  function reassignHost(r) {
    if (host(r)?.connected) return;
    r.players.forEach((x) => (x.isHost = false));
    const next = r.players.find((x) => x.connected);
    if (next) next.isHost = true;
  }
});

server.listen(PORT, () => console.log(`Imposter server running on http://localhost:${PORT}`));
