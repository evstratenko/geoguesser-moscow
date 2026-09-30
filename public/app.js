const socket = io();

let myRoomCode = null;
let myName = '';
let isHost = false;
let panoPlayer = null;
let guessMap = null;
let guessPlacemark = null;
let currentGuess = null;
let latestRoundSpot = null;
let guessCountdownInterval = null;
let roundCountdownInterval = null;
let myPlayerId = null;

// Цвета меток на итоговой карте — по одному на игрока (зелёный зарезервирован
// под настоящее место, поэтому в палитре его нет).
const PLAYER_COLORS = [
  { preset: 'islands#blueDotIcon', hex: '#3d7bfd' },
  { preset: 'islands#violetDotIcon', hex: '#9b59d0' },
  { preset: 'islands#orangeDotIcon', hex: '#ff9f43' },
  { preset: 'islands#yellowDotIcon', hex: '#ffd166' },
];
let playerColorIndex = {}; // playerId -> индекс в PLAYER_COLORS

function assignColors(players) {
  playerColorIndex = {};
  players.forEach((p, i) => {
    playerColorIndex[p.id] = i % PLAYER_COLORS.length;
  });
}

function colorFor(playerId) {
  return PLAYER_COLORS[playerColorIndex[playerId] ?? 0];
}

socket.on('connect', () => {
  myPlayerId = socket.id;
});

const screens = {
  lobby: document.getElementById('screen-lobby'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  result: document.getElementById('screen-result'),
  gameover: document.getElementById('screen-gameover'),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---------- Lobby ----------

document.getElementById('create-btn').addEventListener('click', () => {
  myName = document.getElementById('name-input').value.trim() || 'Игрок 1';
  const mode = document.querySelector('input[name="mode"]:checked').value;
  socket.emit('create-room', { name: myName, mode }, (res) => {
    if (!res.ok) return showLobbyError('Не удалось создать комнату');
    myRoomCode = res.code;
    document.getElementById('room-code-display').textContent = myRoomCode;
    showScreen('waiting');
    renderWaiting(res.state);
  });
});

document.getElementById('join-btn').addEventListener('click', () => {
  myName = document.getElementById('name-input').value.trim() || 'Игрок';
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (code.length !== 4) return showLobbyError('Код комнаты — 4 символа');
  socket.emit('join-room', { code, name: myName }, (res) => {
    if (!res.ok) return showLobbyError(res.error);
    myRoomCode = res.code;
    document.getElementById('room-code-display').textContent = myRoomCode;
    showScreen('waiting');
    renderWaiting(res.state);
  });
});

function showLobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg;
}

function renderWaiting(state) {
  isHost = state.hostId === socket.id;
  const statusEl = document.getElementById('waiting-status');
  const startBtn = document.getElementById('start-btn');
  const listEl = document.getElementById('waiting-players');
  document.getElementById('waiting-mode').textContent =
    state.mode === 'center' ? '🎯 Режим: только центр (в пределах ТТК)' : '🗺 Режим: вся Москва';
  listEl.innerHTML = state.players
    .map((p, i) => `<li>${p.name}${i === 0 ? ' 👑' : ''}${p.id === socket.id ? ' (вы)' : ''}</li>`)
    .join('');

  if (state.players.length >= state.minPlayers) {
    const spotsLeft = state.maxPlayers - state.players.length;
    statusEl.textContent =
      spotsLeft > 0
        ? `Можно начинать, или подождите ещё до ${spotsLeft} игрок(ов) (максимум ${state.maxPlayers}).`
        : 'Комната заполнена — можно начинать.';
    if (isHost) startBtn.classList.remove('hidden');
    else startBtn.classList.add('hidden');
  } else {
    statusEl.textContent = `Нужно ещё минимум ${state.minPlayers - state.players.length} игрок(ов)…`;
    startBtn.classList.add('hidden');
  }
}

document.getElementById('start-btn').addEventListener('click', (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Запускаем…';
  socket.emit('start-game');
});

socket.on('room-update', (state) => {
  if (!state.started) renderWaiting(state);
});

socket.on('player-left-mid-game', (data) => {
  isHost = data.hostId === socket.id;
  assignColors(data.players);
  renderScoreboard(data.players);
  const note = document.getElementById('guess-status');
  if (note) note.textContent = `${data.name} вышел(а) из игры. Продолжаем без него/неё.`;
});

// ---------- Game ----------

socket.on('round-start', (data) => {
  latestRoundSpot = data;
  currentGuess = null;
  stopGuessCountdown();
  if (data.hostId) isHost = data.hostId === socket.id;
  if (data.players) {
    assignColors(data.players);
    renderScoreboard(data.players);
  }
  document.getElementById('round-indicator').textContent = `Раунд ${data.round} / ${data.totalRounds}`;
  document.getElementById('guess-status').textContent = '';
  document.getElementById('submit-guess-btn').disabled = true;
  if (data.deadline) startRoundCountdown(data.deadline);
  showScreen('game');
  loadPanorama(data.lat, data.lon);
  setupGuessMap();
});

function renderScoreboard(players) {
  const el = document.getElementById('scoreboard');
  el.innerHTML = players.map((p) => `<span>${p.name}: ${p.score}</span>`).join('');
}

function formatMMSS(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function stopRoundCountdown() {
  if (roundCountdownInterval) {
    clearInterval(roundCountdownInterval);
    roundCountdownInterval = null;
  }
  document.getElementById('round-timer').textContent = '';
}

function startRoundCountdown(deadline) {
  stopRoundCountdown();
  const el = document.getElementById('round-timer');
  const tick = () => {
    const secondsLeft = Math.round((deadline - Date.now()) / 1000);
    if (secondsLeft <= 0) {
      el.textContent = '⏱ 0:00';
      stopRoundCountdown();
      return;
    }
    el.textContent = `⏱ ${formatMMSS(secondsLeft)}`;
  };
  tick();
  roundCountdownInterval = setInterval(tick, 1000);
}

function stopGuessCountdown() {
  if (guessCountdownInterval) {
    clearInterval(guessCountdownInterval);
    guessCountdownInterval = null;
  }
  document.getElementById('guess-panel').classList.remove('urgent');
  document.getElementById('guess-status').classList.remove('urgent');
}

function startGuessCountdown(deadline, waitingFor) {
  stopGuessCountdown();
  document.getElementById('guess-panel').classList.add('urgent');
  const statusEl = document.getElementById('guess-status');
  statusEl.classList.add('urgent');
  const tick = () => {
    const secondsLeft = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    statusEl.textContent = `Ждём: ${waitingFor.join(', ')} — осталось ${secondsLeft} сек`;
    if (secondsLeft <= 0) stopGuessCountdown();
  };
  tick();
  guessCountdownInterval = setInterval(tick, 1000);
}

function loadPanorama(lat, lon) {
  const panoEl = document.getElementById('pano');
  ymaps.ready(() => {
    if (panoPlayer) {
      panoPlayer.destroy();
      panoPlayer = null;
    }
    panoEl.innerHTML = '<p style="color:white;padding:20px">Загружаем панораму…</p>';
    ymaps.panorama
      .locate([lat, lon])
      .then((panoramas) => {
        if (panoramas.length > 0) {
          panoEl.innerHTML = '';
          panoPlayer = new ymaps.panorama.Player('pano', panoramas[0], {
            controls: ['zoomControl'],
          });
        } else {
          panoEl.innerHTML =
            '<p style="color:white;padding:20px">Панорама для этой точки не найдена (нет покрытия рядом). Сообщите об этом — точку можно заменить в списке локаций.</p>';
        }
      })
      .catch((err) => {
        console.error('panorama.locate error:', err);
        panoEl.innerHTML =
          '<p style="color:white;padding:20px">Не удалось загрузить панораму (ошибка API). Откройте консоль браузера (F12) и посмотрите на текст ошибки.</p>';
      });
  });
}

function setupGuessMap() {
  ymaps.ready(() => {
    if (!guessMap) {
      guessMap = new ymaps.Map('guess-map', {
        center: [55.7558, 37.6173],
        zoom: 9,
        controls: ['zoomControl'],
      });
      guessMap.events.add('click', (e) => {
        const coords = e.get('coords');
        placeGuessMarker(coords);
      });
      // Панель реально меняет размер при наведении (не CSS-transform), поэтому
      // карте нужно самой пересчитать проекцию под новый размер контейнера —
      // иначе клик и точка на карте немного расходятся.
      const panelEl = document.getElementById('guess-panel');
      const resync = () => guessMap.container.fitToViewport();
      panelEl.addEventListener('mouseenter', () => setTimeout(resync, 260));
      panelEl.addEventListener('mouseleave', () => setTimeout(resync, 260));
      panelEl.addEventListener('transitionend', resync);
    } else {
      guessMap.setCenter([55.7558, 37.6173], 9);
      if (guessPlacemark) {
        guessMap.geoObjects.remove(guessPlacemark);
        guessPlacemark = null;
      }
    }
    document.getElementById('submit-guess-btn').disabled = true;
  });
}

function placeGuessMarker(coords) {
  if (guessPlacemark) guessMap.geoObjects.remove(guessPlacemark);
  guessPlacemark = new ymaps.Placemark(coords, {}, { preset: 'islands#redDotIcon' });
  guessMap.geoObjects.add(guessPlacemark);
  currentGuess = { lat: coords[0], lon: coords[1] };
  document.getElementById('submit-guess-btn').disabled = false;
}

document.getElementById('submit-guess-btn').addEventListener('click', () => {
  if (!currentGuess) return;
  socket.emit('submit-guess', currentGuess);
  document.getElementById('submit-guess-btn').disabled = true;
  document.getElementById('guess-status').textContent = 'Догадка отправлена, ждём остальных…';
});

socket.on('guess-received', (data) => {
  if (data.waitingFor.length > 0 && data.deadline) {
    startGuessCountdown(data.deadline, data.waitingFor);
  } else if (data.waitingFor.length > 0) {
    document.getElementById('guess-status').textContent = `Ждём: ${data.waitingFor.join(', ')}`;
  }
});

// ---------- Round result ----------

socket.on('round-result', (data) => {
  stopGuessCountdown();
  stopRoundCountdown();
  showScreen('result');
  document.getElementById('result-title').textContent =
    `Раунд ${data.round} / ${data.totalRounds} — ${data.actual.name}`;

  const listEl = document.getElementById('result-list');
  listEl.innerHTML = '';
  data.results
    .sort((a, b) => b.roundScore - a.roundScore)
    .forEach((r) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      const distText = r.distance != null ? `${Math.round(r.distance)} м` : 'не успел(а) угадать';
      const swatch = `<span class="color-dot" style="background:${colorFor(r.id).hex}"></span>`;
      row.innerHTML = `<div><div class="name">${swatch}${r.name}</div><div class="meta">${distText}</div></div><div>+${r.roundScore} (всего ${r.totalScore})</div>`;
      listEl.appendChild(row);
    });

  const isLast = data.round >= data.totalRounds;
  const nextBtn = document.getElementById('next-round-btn');
  nextBtn.textContent = isLast ? 'Показать итог' : 'Следующий раунд';
  if (isHost) {
    document.getElementById('next-round-note').textContent = isLast
      ? 'Это был последний раунд — рассмотрите карту и жмите «Показать итог».'
      : 'Когда оба посмотрели на карту — жмите «Следующий раунд».';
    nextBtn.classList.remove('hidden');
    nextBtn.disabled = false;
  } else {
    document.getElementById('next-round-note').textContent = isLast
      ? 'Это был последний раунд — ждём, когда хост покажет итог.'
      : 'Ждём, когда хост начнёт следующий раунд…';
    nextBtn.classList.add('hidden');
  }

  ymaps.ready(() => {
    const el = document.getElementById('result-map');
    el.innerHTML = '';
    const map = new ymaps.Map('result-map', {
      center: [data.actual.lat, data.actual.lon],
      zoom: 11,
      controls: ['zoomControl'],
    });
    const actualPm = new ymaps.Placemark(
      [data.actual.lat, data.actual.lon],
      { hintContent: 'Настоящее место' },
      { preset: 'islands#greenDotIcon' }
    );
    map.geoObjects.add(actualPm);
    data.results.forEach((r) => {
      if (!r.guess) return;
      const pm = new ymaps.Placemark(
        [r.guess.lat, r.guess.lon],
        { hintContent: `${r.name}: ${Math.round(r.distance)} м` },
        { preset: colorFor(r.id).preset }
      );
      map.geoObjects.add(pm);
      const line = new ymaps.Polyline(
        [[data.actual.lat, data.actual.lon], [r.guess.lat, r.guess.lon]],
        {},
        { strokeColor: '#9aa9bd', strokeWidth: 2, strokeStyle: 'dash' }
      );
      map.geoObjects.add(line);
    });
    map.setBounds(map.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 40 });
  });
});

document.getElementById('next-round-btn').addEventListener('click', (e) => {
  socket.emit('next-round');
  e.target.disabled = true;
  document.getElementById('next-round-note').textContent = 'Продолжаем…';
});

// ---------- Game over ----------

socket.on('game-over', (data) => {
  stopGuessCountdown();
  stopRoundCountdown();
  showScreen('gameover');
  const el = document.getElementById('final-scores');
  el.innerHTML = '';
  const sorted = [...data.players].sort((a, b) => b.score - a.score);
  sorted.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'final-row' + (i === 0 ? ' winner' : '');
    row.innerHTML = `<span>${i === 0 ? '🏆 ' : ''}${p.name}</span><span>${p.score}</span>`;
    el.appendChild(row);
  });});

document.getElementById('play-again-btn').addEventListener('click', () => location.reload());
