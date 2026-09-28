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
  socket.emit('create-room', { name: myName }, (res) => {
    if (!res.ok) return showLobbyError('Не удалось создать комнату');
    myRoomCode = res.code;
    isHost = true;
    document.getElementById('room-code-display').textContent = myRoomCode;
    showScreen('waiting');
    renderWaiting(res.state);
  });
});

document.getElementById('join-btn').addEventListener('click', () => {
  myName = document.getElementById('name-input').value.trim() || 'Игрок 2';
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (code.length !== 4) return showLobbyError('Код комнаты — 4 символа');
  socket.emit('join-room', { code, name: myName }, (res) => {
    if (!res.ok) return showLobbyError(res.error);
    myRoomCode = res.code;
    isHost = false;
    document.getElementById('room-code-display').textContent = myRoomCode;
    showScreen('waiting');
    renderWaiting(res.state);
  });
});

function showLobbyError(msg) {
  document.getElementById('lobby-error').textContent = msg;
}

function renderWaiting(state) {
  const statusEl = document.getElementById('waiting-status');
  const startBtn = document.getElementById('start-btn');
  if (state.players.length >= 2) {
    statusEl.textContent = `Оба игрока на месте: ${state.players.map((p) => p.name).join(' и ')}`;
    if (isHost) startBtn.classList.remove('hidden');
  } else {
    statusEl.textContent = 'Ожидаем второго игрока…';
    startBtn.classList.add('hidden');
  }
}

document.getElementById('start-btn').addEventListener('click', () => {
  socket.emit('start-game');
});

socket.on('room-update', (state) => {
  if (!state.started) renderWaiting(state);
});

socket.on('player-left', () => {
  alert('Второй игрок отключился. Комната закрыта.');
  location.reload();
});

// ---------- Поиск случайной точки (делает хост) ----------

const MOSCOW_CENTER = [55.7522, 37.6156];
const MAX_PANO_DISTANCE_M = 300; // панорама должна быть не дальше от случайной точки

function randomMoscowPoint() {
  // равномерно внутри эллипса примерно по границе МКАД
  for (;;) {
    const a = Math.random() * 2 - 1;
    const b = Math.random() * 2 - 1;
    if (a * a + b * b <= 1) return [MOSCOW_CENTER[0] + a * 0.15, MOSCOW_CENTER[1] + b * 0.26];
  }
}

function distMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function findRandomSpot(maxAttempts = 25) {
  await new Promise((resolve) => ymaps.ready(resolve));
  for (let i = 0; i < maxAttempts; i++) {
    const pt = randomMoscowPoint();
    try {
      const panoramas = await ymaps.panorama.locate(pt);
      if (panoramas.length > 0) {
        const pos = panoramas[0].getPosition();
        if (distMeters(pt, pos) <= MAX_PANO_DISTANCE_M) return { lat: pos[0], lon: pos[1] };
      }
    } catch (err) {
      console.warn('locate failed, retrying', err);
    }
  }
  return null;
}

socket.on('find-spot', async () => {
  document.getElementById('next-round-note').textContent = 'Ищем случайную точку…';
  const spot = await findRandomSpot();
  if (spot) socket.emit('spot-found', spot);
  else socket.emit('spot-failed');
});

// ---------- Game ----------

socket.on('round-start', (data) => {
  latestRoundSpot = data;
  currentGuess = null;
  stopGuessCountdown();
  document.getElementById('round-indicator').textContent = `Раунд ${data.round} / ${data.totalRounds}`;
  document.getElementById('guess-status').textContent = '';
  document.getElementById('submit-guess-btn').disabled = true;
  if (data.players) renderScoreboard(data.players);
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
}

function startGuessCountdown(deadline, waitingFor) {
  stopGuessCountdown();
  const statusEl = document.getElementById('guess-status');
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
  document.getElementById('guess-status').textContent = 'Догадка отправлена, ждём второго игрока…';
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
      row.innerHTML = `<div><div class="name">${r.name}</div><div class="meta">${distText}</div></div><div>+${r.roundScore} (всего ${r.totalScore})</div>`;
      listEl.appendChild(row);
    });

  const isLast = data.round >= data.totalRounds;
  const nextBtn = document.getElementById('next-round-btn');
  if (isLast) {
    document.getElementById('next-round-note').textContent = 'Это был последний раунд — сейчас покажем итог.';
    nextBtn.classList.add('hidden');
  } else if (isHost) {
    document.getElementById('next-round-note').textContent = 'Когда оба посмотрели на карту — жмите «Следующий раунд».';
    nextBtn.classList.remove('hidden');
    nextBtn.disabled = false;
  } else {
    document.getElementById('next-round-note').textContent = 'Ждём, когда хост начнёт следующий раунд…';
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
        { preset: 'islands#blueDotIcon' }
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

    if (data.actual.name === 'Случайная точка') {
      ymaps
        .geocode([data.actual.lat, data.actual.lon], { results: 1 })
        .then((res) => {
          const first = res.geoObjects.get(0);
          if (first) {
            document.getElementById('result-title').textContent =
              `Раунд ${data.round} / ${data.totalRounds} — ${first.getAddressLine()}`;
          }
        })
        .catch(() => {});
    }
  });
});

document.getElementById('next-round-btn').addEventListener('click', (e) => {
  socket.emit('next-round');
  e.target.disabled = true;
  document.getElementById('next-round-note').textContent = 'Запускаем следующий раунд…';
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
  });
});

document.getElementById('play-again-btn').addEventListener('click', () => location.reload());
