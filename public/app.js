const socket = io();

let myRoomCode = null;
let myName = '';
let isHost = false;
let panoPlayer = null;
let guessMap = null;
let guessPlacemark = null;
let currentGuess = null;
let latestRoundSpot = null;

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

// ---------- Game ----------

socket.on('round-start', (data) => {
  latestRoundSpot = data;
  currentGuess = null;
  document.getElementById('round-indicator').textContent = `Раунд ${data.round} / ${data.totalRounds}`;
  document.getElementById('guess-status').textContent = '';
  document.getElementById('submit-guess-btn').disabled = true;
  showScreen('game');
  loadPanorama(data.lat, data.lon);
  setupGuessMap();
});

function loadPanorama(lat, lon) {
  ymaps.ready(() => {
    if (panoPlayer) {
      panoPlayer.destroy();
      panoPlayer = null;
    }
    document.getElementById('pano').innerHTML = '';
    ymaps.panorama.locate([lat, lon]).then((panoramas) => {
      if (panoramas.length > 0) {
        panoPlayer = new ymaps.panorama.Player('pano', panoramas[0], {
          controls: ['zoomControl'],
        });
      } else {
        document.getElementById('pano').innerHTML =
          '<p style="color:white;padding:20px">Панорама для этой точки не найдена. Пропускаем раунд для честности — сообщите об этом в чате.</p>';
      }
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
  if (data.waitingFor.length > 0) {
    document.getElementById('guess-status').textContent = `Ждём: ${data.waitingFor.join(', ')}`;
  }
});

// ---------- Round result ----------

socket.on('round-result', (data) => {
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
  document.getElementById('next-round-note').textContent = isLast
    ? 'Это был последний раунд — сейчас покажем итог.'
    : 'Следующий раунд начнётся через несколько секунд…';

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
  });
});

// ---------- Game over ----------

socket.on('game-over', (data) => {
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
