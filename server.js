const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ROUNDS_PER_GAME = 5;
const ROUND_TIMEOUT_MS = 90 * 1000; // если игрок завис — раунд всё равно завершится
const SCORE_DECAY_METERS = 4000; // насколько быстро падают очки с расстоянием

// Точки в Москве с хорошим покрытием Яндекс.Панорам (центр, известные локации).
// Если точной панорамы нет — клиент сам подтянет ближайшую через ymaps.panorama.locate().
const MOSCOW_SPOTS = [
  { lat: 55.7539, lon: 37.6208, name: 'Красная площадь' },
  { lat: 55.7601, lon: 37.6186, name: 'Тверская улица' },
  { lat: 55.7495, lon: 37.5919, name: 'Арбат' },
  { lat: 55.7396, lon: 37.5964, name: 'Патриаршие пруды' },
  { lat: 55.7312, lon: 37.6011, name: 'Парк Горького' },
  { lat: 55.8296, lon: 37.6323, name: 'ВДНХ' },
  { lat: 55.7100, lon: 37.5340, name: 'Воробьёвы горы' },
  { lat: 55.7415, lon: 37.6156, name: 'Кремлёвская набережная' },
  { lat: 55.7268, lon: 37.5563, name: 'Новодевичий монастырь' },
  { lat: 55.7554, lon: 37.6288, name: 'Китай-город' },
  { lat: 55.7373, lon: 37.6296, name: 'Замоскворечье' },
  { lat: 55.7708, lon: 37.6216, name: 'Цветной бульвар' },
  { lat: 55.7654, lon: 37.6516, name: 'Чистые пруды' },
  { lat: 55.7616, lon: 37.6215, name: 'Кузнецкий мост' },
  { lat: 55.7539, lon: 37.6178, name: 'Манежная площадь' },
  { lat: 55.7292, lon: 37.5106, name: 'Поклонная гора' },
  { lat: 55.7898, lon: 37.7474, name: 'Измайловский кремль' },
  { lat: 55.6688, lon: 37.6707, name: 'Коломенское' },
  { lat: 55.6156, lon: 37.6666, name: 'Царицыно' },
  { lat: 55.7947, lon: 37.6789, name: 'Сокольники' },
  { lat: 55.7442, lon: 37.4886, name: 'Филёвский парк' },
  { lat: 55.7597, lon: 37.6280, name: 'Лубянская площадь' },
  { lat: 55.7534, lon: 37.5304, name: 'МГУ, Ломоносовский проспект' },
  { lat: 55.7764, lon: 37.5825, name: 'Белорусская' },
  { lat: 55.7565, lon: 37.6560, name: 'Курский вокзал' },
  { lat: 55.7415, lon: 37.6532, name: 'Таганская площадь' },
  { lat: 55.7524, lon: 37.5834, name: 'Новый Арбат' },
  { lat: 55.7501, lon: 37.6284, name: 'Парк Зарядье' },
  { lat: 55.7089, lon: 37.6156, name: 'Даниловский район' },
  { lat: 55.8058, lon: 37.4913, name: 'Химки-Ховрино' },
];

/** rooms: code -> { players: [{id,name,score}], round, order, used, guesses, timer, started, gameOver } */
const rooms = new Map();

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function pickRoundOrder() {
  const shuffled = [...MOSCOW_SPOTS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, ROUNDS_PER_GAME);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function scoreForDistance(distanceMeters) {
  return Math.round(5000 * Math.exp(-distanceMeters / SCORE_DECAY_METERS));
}

function publicRoomState(room) {
  return {
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score })),
    round: room.round,
    totalRounds: ROUNDS_PER_GAME,
    started: room.started,
    gameOver: room.gameOver,
  };
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function startRound(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearRoomTimer(room);
  room.guesses = {};
  const spot = room.order[room.round];
  io.to(code).emit('round-start', {
    round: room.round + 1,
    totalRounds: ROUNDS_PER_GAME,
    lat: spot.lat,
    lon: spot.lon,
  });
  room.timer = setTimeout(() => finishRound(code), ROUND_TIMEOUT_MS);
}

function finishRound(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearRoomTimer(room);
  const spot = room.order[room.round];
  const results = room.players.map((p) => {
    const g = room.guesses[p.id];
    const distance = g ? haversineMeters(spot.lat, spot.lon, g.lat, g.lon) : null;
    const roundScore = g ? scoreForDistance(distance) : 0;
    p.score += roundScore;
    return {
      id: p.id,
      name: p.name,
      guess: g ? { lat: g.lat, lon: g.lon } : null,
      distance,
      roundScore,
      totalScore: p.score,
    };
  });

  io.to(code).emit('round-result', {
    round: room.round + 1,
    totalRounds: ROUNDS_PER_GAME,
    actual: { lat: spot.lat, lon: spot.lon, name: spot.name },
    results,
  });

  room.round += 1;

  if (room.round >= ROUNDS_PER_GAME) {
    room.gameOver = true;
    setTimeout(() => {
      io.to(code).emit('game-over', { players: room.players.map((p) => ({ name: p.name, score: p.score })) });
    }, 300);
  } else {
    setTimeout(() => startRound(code), 4000); // пауза, чтобы посмотреть результат раунда
  }
}

io.on('connection', (socket) => {
  socket.on('create-room', ({ name }, cb) => {
    const code = makeRoomCode();
    const room = {
      players: [{ id: socket.id, name: (name || 'Игрок 1').slice(0, 20), score: 0 }],
      round: 0,
      order: pickRoundOrder(),
      guesses: {},
      timer: null,
      started: false,
      gameOver: false,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code, state: publicRoomState(room) });
  });

  socket.on('join-room', ({ code, name }, cb) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return cb({ ok: false, error: 'Комната не найдена. Проверьте код.' });
    if (room.players.length >= 2) return cb({ ok: false, error: 'В комнате уже двое игроков.' });
    room.players.push({ id: socket.id, name: (name || 'Игрок 2').slice(0, 20), score: 0 });
    socket.join(code.toUpperCase());
    socket.data.roomCode = code.toUpperCase();
    cb({ ok: true, code: code.toUpperCase(), state: publicRoomState(room) });
    io.to(code.toUpperCase()).emit('room-update', publicRoomState(room));
  });

  socket.on('start-game', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.players.length < 2 || room.started) return;
    room.started = true;
    io.to(code).emit('room-update', publicRoomState(room));
    startRound(code);
  });

  socket.on('submit-guess', ({ lat, lon }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.gameOver) return;
    room.guesses[socket.id] = { lat, lon };
    io.to(code).emit('guess-received', {
      playerId: socket.id,
      waitingFor: room.players.filter((p) => !room.guesses[p.id]).map((p) => p.name),
    });
    if (room.players.every((p) => room.guesses[p.id])) {
      finishRound(code);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;
    io.to(code).emit('player-left');
    clearRoomTimer(room);
    rooms.delete(code);
  });
});

server.listen(PORT, () => {
  console.log(`Geoguesser Moscow running on port ${PORT}`);
});
