// ─── Socket & State ──────────────────────────────────────────────────────────
const socket = io();

let state = {
  playerId: null,
  roomCode: null,
  playerName: null,
  isHost: false,
  currentGuess: "",
  gamePhase: "home",
  room: null,
  muted: false,
  hintLetters: {},       // position -> letter revealed by hint
  roundCountdownTimer: null,
  timeLimit: 60,
  timeLimitMax: 60,
};

const EMOJIS = ["👨","👩","👦","👧","🧔","👴","👵","🧒","🐶","🐱","🦊","🐻","🦁","🐯","🐸","🐼","🦄","🤖","👾","🎃"];
const KEYBOARD_ROWS = [
  ["Q","W","E","R","T","Y","U","I","O","P"],
  ["A","S","D","F","G","H","J","K","L"],
  ["ENTER","Z","X","C","V","B","N","M","⌫"]
];

// ─── Screen Management ───────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ─── Emoji Pickers ───────────────────────────────────────────────────────────
function buildEmojiPicker(containerId, hiddenId) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  EMOJIS.forEach((em, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "emoji-btn" + (i === 17 ? " selected" : "");
    btn.textContent = em;
    btn.onclick = () => {
      container.querySelectorAll(".emoji-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      document.getElementById(hiddenId).value = em;
    };
    container.appendChild(btn);
  });
}

buildEmojiPicker("create-emoji-picker", "create-emoji");
buildEmojiPicker("join-emoji-picker", "join-emoji");

// ─── Mode Change ─────────────────────────────────────────────────────────────
function onModeChange() {
  const mode = document.getElementById("create-mode").value;
  document.getElementById("time-limit-row").style.display = mode === "time_attack" ? "flex" : "none";
  document.getElementById("time-limit-row").style.flexDirection = "column";
}
onModeChange();

// ─── Room Actions ────────────────────────────────────────────────────────────
function createRoom() {
  const name = document.getElementById("create-name").value.trim();
  if (!name) return showToast("Please enter your name");
  const emoji = document.getElementById("create-emoji").value;
  const gameMode = document.getElementById("create-mode").value;
  const totalRounds = document.getElementById("create-rounds").value;
  const timeLimit = document.getElementById("create-timelimit").value;
  const customWords = document.getElementById("create-customwords").value;
  state.playerName = name;
  socket.emit("create_room", { playerName: name, emoji, gameMode, totalRounds, timeLimit, customWords });
}

function joinRoom() {
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  const name = document.getElementById("join-name").value.trim();
  if (!code) return showToast("Please enter a room code");
  if (!name)  return showToast("Please enter your name");
  const emoji = document.getElementById("join-emoji").value;
  state.playerName = name;
  document.getElementById("join-error").textContent = "";
  socket.emit("join_room", { roomCode: code, playerName: name, emoji });
}

function forceStart() { socket.emit("force_start", { roomCode: state.roomCode }); }
function toggleReady() { socket.emit("player_ready", { roomCode: state.roomCode }); }
function nextRound()   { socket.emit("next_round",   { roomCode: state.roomCode }); }
function restartGame() { socket.emit("restart_game", { roomCode: state.roomCode }); }
function newGame() {
  state = { ...state, playerId: null, roomCode: null, isHost: false, currentGuess: "", gamePhase: "home", room: null, hintLetters: {} };
  showScreen("screen-home");
}
function useHint()     { socket.emit("use_hint",     { roomCode: state.roomCode }); }

function copyRoomCode() {
  navigator.clipboard.writeText(state.roomCode).then(() => showToast("📋 Copied!"));
}

// ─── Socket Events ───────────────────────────────────────────────────────────
socket.on("room_created", ({ roomCode, playerId }) => {
  state.playerId = playerId;
  state.roomCode = roomCode;
  state.isHost = true;
});

socket.on("join_success", ({ playerId, roomState }) => {
  state.playerId = playerId;
  state.roomCode = roomState.code;
  state.isHost = roomState.hostId === playerId;
  state.room = roomState;
  renderLobby(roomState);
  showScreen("screen-lobby");
});

socket.on("join_error", ({ message }) => {
  document.getElementById("join-error").textContent = message;
});

socket.on("room_updated", (room) => {
  state.room = room;
  state.isHost = room.hostId === state.playerId;

  if (room.phase === "lobby") {
    renderLobby(room);
    if (document.getElementById("screen-lobby").classList.contains("active") === false &&
        document.getElementById("screen-gameover").classList.contains("active") === false) {
      showScreen("screen-lobby");
    }
    if (document.getElementById("screen-gameover").classList.contains("active")) {
      // stayed on gameover until they hit play again
    }
  } else if (room.phase === "playing") {
    renderGame(room);
  } else if (room.phase === "roundover") {
    // handled by round_over event
  } else if (room.phase === "gameover") {
    // handled by game_over event
  }

  // Update score in topbar
  if (room.phase === "playing") {
    const me = room.players[state.playerId];
    if (me) document.getElementById("game-score").textContent = `${me.score} pts`;
  }
});

socket.on("game_started", ({ round, mode, totalRounds }) => {
  state.currentGuess = "";
  state.hintLetters = {};
  state.gamePhase = "playing";
  showScreen("screen-game");

  // Setup topbar
  document.getElementById("game-room-code").textContent = state.roomCode;
  document.getElementById("game-round-info").textContent = `Round ${round}/${totalRounds}`;
  document.getElementById("game-score").textContent = "0 pts";

  const modeLabels = { solo_race: "🏁 Solo Race", time_attack: "⚡ Time Attack", relay: "🔄 Relay", hint_mode: "💡 Hint Mode" };
  document.getElementById("topbar-mode-badge").textContent = modeLabels[mode] || mode;

  // Show/hide time attack bar
  document.getElementById("time-attack-bar-wrap").style.display = mode === "time_attack" ? "flex" : "none";
  if (mode === "time_attack") {
    state.timeLimitMax = state.room ? state.room.timeLimit : 60;
    updateTimerBar(state.timeLimitMax, state.timeLimitMax);
  }

  // Show/hide hint
  document.getElementById("hint-btn-wrap").style.display = mode === "hint_mode" ? "block" : "none";
  document.getElementById("hint-row").style.display = mode === "hint_mode" ? "flex" : "none";

  buildGrid();
  buildKeyboard();
  buildHintRow();
});

socket.on("timer_tick", ({ timeRemaining }) => {
  const max = state.timeLimitMax || 60;
  updateTimerBar(timeRemaining, max);
  document.getElementById("time-attack-secs").textContent = timeRemaining + "s";
  if (timeRemaining <= 10) {
    document.getElementById("time-attack-fill").classList.add("danger");
    playSound("tick");
  }
});

socket.on("guess_made", ({ playerId, guess, colors, attemptsUsed, solved, relaySharedGuesses, relaySharedColors, relayTurnIndex }) => {
  if (playerId === state.playerId) {
    revealGuess(guess, colors, attemptsUsed - 1);
    if (solved) {
      setTimeout(() => {
        playSound("correct");
        launchConfetti();
      }, colors.length * 350);
    } else {
      playSound("wrong");
    }
    state.currentGuess = "";
    updateCurrentRow();
  }

  // Update relay shared board if relay mode
  if (state.room && state.room.gameMode === "relay") {
    updateRelayBoard(relaySharedGuesses, relaySharedColors, relayTurnIndex);
  }
});

socket.on("round_over", ({ word, playerResults, roundNumber }) => {
  if (state.roundCountdownTimer) clearInterval(state.roundCountdownTimer);
  showScreen("screen-roundover");
  renderRoundOver(word, playerResults, roundNumber);
  launchConfetti();
});

socket.on("game_over", ({ players }) => {
  if (state.roundCountdownTimer) clearInterval(state.roundCountdownTimer);
  showScreen("screen-gameover");
  renderGameOver(players);
  launchConfetti();
});

socket.on("hint_received", ({ position, letter }) => {
  state.hintLetters[position] = letter;
  updateHintRow();
});

socket.on("score_updated", ({ playerId, score }) => {
  if (playerId === state.playerId && state.room) {
    state.room.players[playerId].score = score;
    document.getElementById("game-score").textContent = `${score} pts`;
  }
});

socket.on("toast", ({ message }) => showToast(message));

// ─── Lobby Render ────────────────────────────────────────────────────────────
function renderLobby(room) {
  document.getElementById("lobby-room-code").textContent = room.code;
  const players = Object.values(room.players);

  const list = document.getElementById("lobby-players");
  list.innerHTML = players.map(p => `
    <div class="player-card">
      <span class="p-emoji">${p.emoji}</span>
      <span class="p-name">${escHtml(p.name)}</span>
      ${room.hostId === p.id ? '<span class="p-host">👑 Host</span>' : ''}
      ${p.isReady ? '<span class="p-ready">✓ Ready</span>' : '<span class="p-waiting">Waiting...</span>'}
    </div>`).join("");

  const modeLabels = { solo_race: "Solo Race", time_attack: "Time Attack", relay: "Relay Mode", hint_mode: "Hint Mode" };
  document.getElementById("lobby-meta").textContent =
    `Mode: ${modeLabels[room.gameMode] || room.gameMode} · Rounds: ${room.totalRounds}`;

  const hostCtrl  = document.getElementById("host-controls");
  const guestCtrl = document.getElementById("guest-controls");
  if (state.isHost) {
    hostCtrl.style.display = "block";
    guestCtrl.style.display = "none";
    document.getElementById("btn-force-start").disabled = players.length < 1;
  } else {
    hostCtrl.style.display = "none";
    guestCtrl.style.display = "block";
    const me = room.players[state.playerId];
    document.getElementById("btn-ready").textContent = me && me.isReady ? "✓ Ready!" : "✋ I'm Ready!";
  }

  const allReady = players.length > 0 && players.every(p => p.isReady);
  document.getElementById("lobby-waiting").style.display = allReady ? "none" : "block";
}

// ─── Game Grid ───────────────────────────────────────────────────────────────
function buildGrid() {
  const grid = document.getElementById("guess-grid");
  grid.innerHTML = "";
  for (let r = 0; r < 6; r++) {
    const row = document.createElement("div");
    row.className = "guess-row";
    row.id = `row-${r}`;
    for (let c = 0; c < 5; c++) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.id = `tile-${r}-${c}`;
      row.appendChild(tile);
    }
    grid.appendChild(row);
  }

  // Restore previous guesses if reconnecting
  if (state.room) {
    const me = state.room.players[state.playerId];
    if (me && me.guesses.length > 0) {
      me.guesses.forEach((g, i) => {
        revealGuess(g, me.colors[i], i, false);
      });
    }
    updateCurrentRow();
  }
}

function buildKeyboard() {
  const kb = document.getElementById("keyboard");
  kb.innerHTML = "";
  KEYBOARD_ROWS.forEach(row => {
    const rowEl = document.createElement("div");
    rowEl.className = "key-row";
    row.forEach(k => {
      const btn = document.createElement("button");
      btn.className = "key" + (k.length > 1 ? " wide" : "");
      btn.textContent = k;
      btn.dataset.key = k;
      btn.onclick = () => handleKey(k);
      rowEl.appendChild(btn);
    });
    kb.appendChild(rowEl);
  });
}

function buildHintRow() {
  const row = document.getElementById("hint-row");
  row.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const tile = document.createElement("div");
    tile.className = "hint-tile";
    tile.id = `hint-${i}`;
    tile.textContent = state.hintLetters[i] || "";
    row.appendChild(tile);
  }
}

function updateHintRow() {
  for (let i = 0; i < 5; i++) {
    const tile = document.getElementById(`hint-${i}`);
    if (tile) tile.textContent = state.hintLetters[i] || "";
  }
}

function updateCurrentRow() {
  if (!state.room) return;
  const me = state.room.players[state.playerId];
  if (!me) return;
  const rowIdx = me.attemptsUsed;
  if (rowIdx >= 6) return;
  for (let c = 0; c < 5; c++) {
    const tile = document.getElementById(`tile-${rowIdx}-${c}`);
    if (!tile) return;
    tile.className = "tile current-row";
    tile.textContent = state.currentGuess[c] || "";
    if (state.currentGuess[c]) tile.classList.add("filled");
  }
}

function revealGuess(guess, colors, rowIdx, animate = true) {
  for (let c = 0; c < 5; c++) {
    const tile = document.getElementById(`tile-${rowIdx}-${c}`);
    if (!tile) continue;
    const color = colors[c];
    const delay = animate ? c * 320 : 0;
    setTimeout(() => {
      tile.textContent = guess[c];
      tile.className = `tile ${color}`;
      if (animate) {
        tile.classList.add("flip");
        playSound("flip");
      }
    }, delay);
  }
}

// ─── Keyboard Input ──────────────────────────────────────────────────────────
document.addEventListener("keydown", (e) => {
  if (state.gamePhase !== "playing") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toUpperCase();
  if (key === "ENTER") handleKey("ENTER");
  else if (key === "BACKSPACE") handleKey("⌫");
  else if (/^[A-Z]$/.test(key)) handleKey(key);
});

function handleKey(key) {
  if (state.gamePhase !== "playing") return;
  if (!state.room) return;
  const me = state.room.players[state.playerId];
  if (!me || me.solved || me.attemptsUsed >= 6) return;

  // Relay: disable if not your turn
  if (state.room.gameMode === "relay") {
    const playerIds = Object.keys(state.room.players);
    const currentId = playerIds[state.room.relayTurnIndex % playerIds.length];
    if (currentId !== state.playerId) return;
  }

  if (key === "⌫" || key === "BACKSPACE") {
    state.currentGuess = state.currentGuess.slice(0, -1);
    updateCurrentRow();
  } else if (key === "ENTER") {
    if (state.currentGuess.length !== 5) {
      shakeRow(me.attemptsUsed);
      showToast("Not enough letters");
      return;
    }
    socket.emit("submit_guess", { roomCode: state.roomCode, guess: state.currentGuess });
  } else if (/^[A-Z]$/.test(key) && state.currentGuess.length < 5) {
    state.currentGuess += key;
    updateCurrentRow();
  }
}

function shakeRow(rowIdx) {
  const row = document.getElementById(`row-${rowIdx}`);
  if (!row) return;
  row.classList.remove("shake");
  void row.offsetWidth;
  row.classList.add("shake");
}

// ─── Game Render ─────────────────────────────────────────────────────────────
function renderGame(room) {
  document.getElementById("game-round-info").textContent = `Round ${room.currentRound}/${room.totalRounds}`;

  const me = room.players[state.playerId];
  if (me) document.getElementById("game-score").textContent = `${me.score} pts`;

  // Keyboard colors
  if (me) updateKeyboardColors(me.guesses, me.colors);

  // Opponents
  renderOpponents(room);

  // Relay info
  if (room.gameMode === "relay") {
    const playerIds = Object.keys(room.players);
    const activeId = playerIds[room.relayTurnIndex % playerIds.length];
    const activePlayer = room.players[activeId];
    const relayInfo = document.getElementById("relay-info");
    relayInfo.style.display = "block";
    if (activePlayer) {
      relayInfo.textContent = activeId === state.playerId
        ? "🎮 It's YOUR turn!"
        : `🎮 ${activePlayer.name}'s turn`;
    }
  }
}

function renderOpponents(room) {
  const panel = document.getElementById("opponents-panel");
  panel.innerHTML = "";
  const playerIds = Object.keys(room.players);
  const activeRelayId = room.gameMode === "relay"
    ? playerIds[room.relayTurnIndex % playerIds.length]
    : null;

  Object.values(room.players).forEach(p => {
    if (p.id === state.playerId) return;
    const isActive = activeRelayId === p.id;
    const card = document.createElement("div");
    card.className = "opponent-card" + (isActive ? " active-turn" : "");

    const miniRows = Array.from({ length: 6 }, (_, r) => {
      const colors = p.colors[r] || [];
      const tiles = Array.from({ length: 5 }, (_, c) =>
        `<div class="mini-tile ${colors[c] || ''}"></div>`).join("");
      return `<div class="mini-row">${tiles}</div>`;
    }).join("");

    card.innerHTML = `
      <div class="opp-header">
        <span class="opp-emoji">${p.emoji}</span>
        <span class="opp-name">${escHtml(p.name)}</span>
        <span class="opp-score">${p.score} pts</span>
      </div>
      <div class="opp-meta" style="font-size:0.7rem;color:var(--text-muted);margin-bottom:4px;">
        ${p.solved ? '<span style="color:var(--green-light)">✅ Solved!</span>' : `${p.attemptsUsed}/6`}
        ${isActive ? ' · <span style="color:var(--green-light)">🎮 Turn</span>' : ''}
      </div>
      <div class="mini-grid">${miniRows}</div>`;
    panel.appendChild(card);
  });
}

function updateRelayBoard(sharedGuesses, sharedColors, relayTurnIndex) {
  // Show relay shared board in the main grid
  sharedGuesses.forEach((g, i) => {
    const colors = sharedColors[i] || [];
    for (let c = 0; c < 5; c++) {
      const tile = document.getElementById(`tile-${i}-${c}`);
      if (tile) {
        tile.textContent = g[c];
        tile.className = `tile ${colors[c] || ""}`;
      }
    }
  });
}

function updateKeyboardColors(guesses, colors) {
  const letterColors = {};
  const priority = { green: 3, yellow: 2, gray: 1 };
  guesses.forEach((g, gi) => {
    const c = colors[gi] || [];
    g.split("").forEach((ch, ci) => {
      const existing = letterColors[ch];
      if (!existing || (priority[c[ci]] || 0) > (priority[existing] || 0)) {
        letterColors[ch] = c[ci];
      }
    });
  });
  document.querySelectorAll(".key").forEach(btn => {
    const k = btn.dataset.key;
    if (k && k.length === 1) {
      btn.className = "key " + (letterColors[k] || "");
    }
  });
}

function updateTimerBar(remaining, max) {
  const pct = Math.max(0, remaining / max * 100);
  document.getElementById("time-attack-fill").style.width = pct + "%";
  document.getElementById("time-attack-secs").textContent = remaining + "s";
}

// ─── Round Over Render ───────────────────────────────────────────────────────
function renderRoundOver(word, playerResults, roundNumber) {
  document.getElementById("roundover-title").textContent = `Round ${roundNumber} Complete! 🎉`;

  // Word reveal tiles
  const wordEl = document.getElementById("roundover-word");
  wordEl.innerHTML = word.split("").map(l => `<div class="tile green">${l}</div>`).join("");

  // Leaderboard
  const table = document.getElementById("roundover-leaderboard");
  const medals = ["🥇","🥈","🥉"];
  table.innerHTML = `
    <tr><th>Rank</th><th>Player</th><th>Guesses</th><th>Round Pts</th><th>Total</th></tr>
    ${playerResults.map((p, i) => `
      <tr class="${i < 3 ? `podium-${i+1}` : ''}">
        <td class="rank">${medals[i] || i+1}</td>
        <td>${p.emoji} ${escHtml(p.name)}</td>
        <td>${p.solved ? p.attemptsUsed : "—"}</td>
        <td class="points">+${p.roundScore || 0}</td>
        <td>${p.score}</td>
      </tr>`).join("")}`;

  // Countdown
  let secs = 8;
  document.getElementById("roundover-countdown").textContent = `Next round in ${secs}s...`;
  if (state.roundCountdownTimer) clearInterval(state.roundCountdownTimer);
  state.roundCountdownTimer = setInterval(() => {
    secs--;
    if (secs <= 0) {
      clearInterval(state.roundCountdownTimer);
      document.getElementById("roundover-countdown").textContent = "";
    } else {
      document.getElementById("roundover-countdown").textContent = `Next round in ${secs}s...`;
    }
  }, 1000);

  document.getElementById("host-next-btn").style.display = state.isHost ? "block" : "none";
}

// ─── Game Over Render ────────────────────────────────────────────────────────
function renderGameOver(players) {
  const winner = players[0];
  document.getElementById("winner-announce").textContent =
    winner ? `${winner.emoji} ${winner.name} wins with ${winner.score} pts!` : "No winner";

  const medals = ["🥇","🥈","🥉"];
  const table = document.getElementById("gameover-leaderboard");
  table.innerHTML = `
    <tr><th>Rank</th><th>Player</th><th>Score</th></tr>
    ${players.map((p, i) => `
      <tr class="${i < 3 ? `podium-${i+1}` : ''}">
        <td class="rank">${medals[i] || i+1}</td>
        <td>${p.emoji} ${escHtml(p.name)}</td>
        <td class="points">${p.score}</td>
      </tr>`).join("")}`;
}

// ─── Mute ────────────────────────────────────────────────────────────────────
function toggleMute() {
  state.muted = !state.muted;
  document.getElementById("btn-mute").textContent = state.muted ? "🔇" : "🔊";
}

// ─── Sound Effects (Web Audio API) ──────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playSound(type) {
  if (state.muted) return;
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "flip") {
      osc.frequency.setValueAtTime(600, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now); osc.stop(now + 0.08);
    } else if (type === "correct") {
      [440, 550, 660].forEach((freq, i) => {
        const o2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        o2.connect(g2); g2.connect(ctx.destination);
        o2.frequency.setValueAtTime(freq, now + i * 0.12);
        g2.gain.setValueAtTime(0.12, now + i * 0.12);
        g2.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.2);
        o2.start(now + i * 0.12); o2.stop(now + i * 0.12 + 0.2);
      });
    } else if (type === "wrong") {
      osc.frequency.setValueAtTime(200, now);
      osc.type = "square";
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now); osc.stop(now + 0.15);
    } else if (type === "tick") {
      osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
      osc.start(now); osc.stop(now + 0.05);
    } else if (type === "fanfare") {
      [523, 659, 784].forEach((freq, i) => {
        const o2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        o2.connect(g2); g2.connect(ctx.destination);
        o2.frequency.setValueAtTime(freq, now + i * 0.15);
        g2.gain.setValueAtTime(0.15, now + i * 0.15);
        g2.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.3);
        o2.start(now + i * 0.15); o2.stop(now + i * 0.15 + 0.3);
      });
    }
  } catch (e) { /* silent fail */ }
}

// ─── Confetti ────────────────────────────────────────────────────────────────
async function launchConfetti() {
  try {
    const { default: confetti } = await import("https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.module.mjs");
    confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
  } catch (e) { /* silent fail */ }
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(message, duration = 3000) {
  const container = document.getElementById("toasts");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration + 100);
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
