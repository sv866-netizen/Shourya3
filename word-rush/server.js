const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, "public")));

// ─── In-memory state ──────────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms[code]);
  return code;
}

function checkGuess(guess, word) {
  const result = ["gray", "gray", "gray", "gray", "gray"];
  const wordArr = word.split("");
  const guessArr = guess.split("");
  const wordUsed = [false, false, false, false, false];
  const guessUsed = [false, false, false, false, false];

  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === wordArr[i]) {
      result[i] = "green";
      wordUsed[i] = true;
      guessUsed[i] = true;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (guessUsed[i]) continue;
    for (let j = 0; j < 5; j++) {
      if (!wordUsed[j] && guessArr[i] === wordArr[j]) {
        result[i] = "yellow";
        wordUsed[j] = true;
        break;
      }
    }
  }

  return result;
}

function calculateScore(player, isFirst, isSecond) {
  if (!player.solved) return 0;
  let score = 50;
  score += (6 - player.attemptsUsed) * 10;
  if (isFirst) score += 20;
  else if (isSecond) score += 10;
  return score;
}

function getSafeRoom(room) {
  // Never send the secret word to clients during play
  const safe = JSON.parse(JSON.stringify(room));
  if (safe.phase === "playing" || safe.phase === "lobby") {
    safe.word = null;
  }
  return safe;
}

function getWordList(room) {
  if (room.useCustomWords && room.wordList && room.wordList.length >= 3) {
    return room.wordList;
  }
  return null; // server will use built-in — we pass null and use global WORDS in server context
}

function pickWord(room, serverWords) {
  const list = (room.useCustomWords && room.wordList && room.wordList.length >= 3)
    ? room.wordList
    : serverWords;
  return list[Math.floor(Math.random() * list.length)];
}

function allPlayersDone(room) {
  const players = Object.values(room.players);
  if (players.length === 0) return false;
  return players.every(p => p.solved || p.attemptsUsed >= 6);
}

function startGame(roomCode, serverWords) {
  const room = rooms[roomCode];
  if (!room) return;

  // Clear any existing timer
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }

  room.word = pickWord(room, serverWords);
  room.phase = "playing";
  room.timerStarted = false;
  room.timeRemaining = room.timeLimit;

  // Reset all players
  for (const player of Object.values(room.players)) {
    player.guesses = [];
    player.colors = [];
    player.solved = false;
    player.attemptsUsed = 0;
    player.solvedAt = null;
    player.hintsUsed = 0;
    player.isReady = false;
  }

  // Reset relay state
  room.relayTurnIndex = 0;
  room.relayGuessesThisTurn = 0;
  room.relaySharedGuesses = [];
  room.relaySharedColors = [];

  io.to(roomCode).emit("game_started", {
    wordLength: 5,
    round: room.currentRound,
    mode: room.gameMode,
    totalRounds: room.totalRounds
  });

  io.to(roomCode).emit("room_updated", getSafeRoom(room));

  if (room.gameMode === "time_attack") {
    room.timerStarted = true;
    room.timerInterval = setInterval(() => {
      room.timeRemaining--;
      io.to(roomCode).emit("timer_tick", { timeRemaining: room.timeRemaining });

      if (room.timeRemaining === 30) {
        io.to(roomCode).emit("toast", { message: "⏰ 30 seconds remaining!" });
      }
      if (room.timeRemaining === 10) {
        io.to(roomCode).emit("toast", { message: "⚠️ 10 seconds remaining!" });
      }
      if (room.timeRemaining <= 0) {
        clearInterval(room.timerInterval);
        room.timerInterval = null;
        endRound(roomCode, serverWords);
      }
    }, 1000);
  }

  if (room.gameMode === "relay") {
    const players = Object.values(room.players);
    if (players.length > 0) {
      const currentPlayer = players[room.relayTurnIndex % players.length];
      io.to(roomCode).emit("toast", { message: `🎮 It's ${currentPlayer.name}'s turn!` });
    }
  }
}

function endRound(roomCode, serverWords) {
  const room = rooms[roomCode];
  if (!room || room.phase === "roundover" || room.phase === "gameover") return;

  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }

  room.phase = "roundover";

  // Compute scores
  const players = Object.values(room.players);
  const solved = players.filter(p => p.solved).sort((a, b) => a.solvedAt - b.solvedAt);

  for (const player of players) {
    const isFirst = solved[0] && solved[0].id === player.id;
    const isSecond = solved[1] && solved[1].id === player.id;
    const earned = calculateScore(player, isFirst, isSecond);
    player.score += earned;
    player.roundScore = earned;
  }

  const playerResults = players.sort((a, b) => b.roundScore - a.roundScore);

  io.to(roomCode).emit("round_over", {
    word: room.word,
    playerResults,
    roundNumber: room.currentRound
  });
  io.to(roomCode).emit("room_updated", getSafeRoom(room));

  // Auto-advance after 8s
  room.roundTimer = setTimeout(() => {
    if (!rooms[roomCode]) return;
    if (room.currentRound < room.totalRounds) {
      room.currentRound++;
      startGame(roomCode, serverWords);
    } else {
      room.phase = "gameover";
      const finalPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
      io.to(roomCode).emit("game_over", { players: finalPlayers });
      io.to(roomCode).emit("room_updated", getSafeRoom(room));
    }
  }, 8000);
}

// ─── Load word list ────────────────────────────────────────────────────────────
// We read words.js at startup and parse the array for server-side use
const fs = require("fs");
let SERVER_WORDS = [];
try {
  const wordsFile = fs.readFileSync(path.join(__dirname, "public", "words.js"), "utf8");
  const match = wordsFile.match(/window\.WORDS\s*=\s*(\[[\s\S]*?\])/);
  if (match) {
    SERVER_WORDS = JSON.parse(match[1]);
  }
} catch (e) {
  console.warn("Could not load words.js, using fallback words.");
  SERVER_WORDS = ["CRANE","STARE","PLATE","LIGHT","BRAVE","CHAIR","FLAME","PLANT","STONE","TRAIN"];
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ── Create Room ─────────────────────────────────────────────────────────────
  socket.on("create_room", ({ playerName, emoji, gameMode, totalRounds, timeLimit, customWords }) => {
    const roomCode = generateRoomCode();

    // Validate and parse custom words
    let wordList = [];
    let useCustomWords = false;
    if (customWords && typeof customWords === "string" && customWords.trim()) {
      wordList = customWords.split(",")
        .map(w => w.trim().toUpperCase())
        .filter(w => /^[A-Z]{5}$/.test(w));
      useCustomWords = wordList.length >= 3;
    }

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      word: null,
      wordList,
      useCustomWords,
      currentRound: 1,
      totalRounds: Math.min(Math.max(parseInt(totalRounds) || 5, 1), 10),
      gameMode: gameMode || "solo_race",
      timeLimit: parseInt(timeLimit) || 60,
      timerStarted: false,
      timerInterval: null,
      timeRemaining: parseInt(timeLimit) || 60,
      phase: "lobby",
      players: {},
      relayTurnIndex: 0,
      relayGuessesThisTurn: 0,
      relaySharedGuesses: [],
      relaySharedColors: []
    };

    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: (playerName || "Player").slice(0, 20),
      emoji: emoji || "👾",
      score: 0,
      guesses: [],
      colors: [],
      solved: false,
      attemptsUsed: 0,
      solvedAt: null,
      hintsUsed: 0,
      isReady: false,
      roundScore: 0
    };

    socket.join(roomCode);
    socket.emit("room_created", { roomCode, playerId: socket.id });
    io.to(roomCode).emit("room_updated", getSafeRoom(rooms[roomCode]));
  });

  // ── Join Room ────────────────────────────────────────────────────────────────
  socket.on("join_room", ({ roomCode, playerName, emoji }) => {
    const code = (roomCode || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return socket.emit("join_error", { message: "Room not found" });
    if (room.phase !== "lobby") return socket.emit("join_error", { message: "Game already in progress" });
    if (Object.keys(room.players).length >= 6) return socket.emit("join_error", { message: "Room is full (max 6)" });

    room.players[socket.id] = {
      id: socket.id,
      name: (playerName || "Player").slice(0, 20),
      emoji: emoji || "👾",
      score: 0,
      guesses: [],
      colors: [],
      solved: false,
      attemptsUsed: 0,
      solvedAt: null,
      hintsUsed: 0,
      isReady: false,
      roundScore: 0
    };

    socket.join(code);
    socket.emit("join_success", { playerId: socket.id, roomState: getSafeRoom(room) });
    io.to(code).emit("room_updated", getSafeRoom(room));
  });

  // ── Player Ready ─────────────────────────────────────────────────────────────
  socket.on("player_ready", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].isReady = true;
    io.to(roomCode).emit("room_updated", getSafeRoom(room));

    const players = Object.values(room.players);
    if (players.length >= 2 && players.every(p => p.isReady)) {
      startGame(roomCode, SERVER_WORDS);
    }
  });

  // ── Force Start ──────────────────────────────────────────────────────────────
  socket.on("force_start", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (Object.keys(room.players).length < 1) return;
    startGame(roomCode, SERVER_WORDS);
  });

  // ── Submit Guess ─────────────────────────────────────────────────────────────
  socket.on("submit_guess", ({ roomCode, guess }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "playing") return;

    const player = room.players[socket.id];
    if (!player) return;
    if (player.solved || player.attemptsUsed >= 6) return;

    // Validate guess
    if (!guess || typeof guess !== "string" || !/^[A-Z]{5}$/.test(guess.toUpperCase())) return;
    guess = guess.toUpperCase();

    // Relay mode turn check
    if (room.gameMode === "relay") {
      const playerIds = Object.keys(room.players);
      const currentId = playerIds[room.relayTurnIndex % playerIds.length];
      if (currentId !== socket.id) return;
    }

    const colors = checkGuess(guess, room.word);
    player.guesses.push(guess);
    player.colors.push(colors);
    player.attemptsUsed++;

    const solvedNow = guess === room.word;
    if (solvedNow) {
      player.solved = true;
      player.solvedAt = Date.now();
      io.to(roomCode).emit("toast", { message: `🎉 ${player.name} solved it in ${player.attemptsUsed} ${player.attemptsUsed === 1 ? "try" : "tries"}!` });
    }

    // Relay mode shared board
    if (room.gameMode === "relay") {
      room.relaySharedGuesses.push(guess);
      room.relaySharedColors.push(colors);
      room.relayGuessesThisTurn++;

      if (solvedNow || room.relaySharedGuesses.length >= 6) {
        // end
      } else if (room.relayGuessesThisTurn >= 2) {
        room.relayGuessesThisTurn = 0;
        room.relayTurnIndex++;
        const playerIds = Object.keys(room.players);
        const nextPlayer = room.players[playerIds[room.relayTurnIndex % playerIds.length]];
        if (nextPlayer) {
          io.to(roomCode).emit("toast", { message: `🎮 It's ${nextPlayer.name}'s turn!` });
        }
      }
    }

    io.to(roomCode).emit("guess_made", {
      playerId: socket.id,
      guess,
      colors,
      attemptsUsed: player.attemptsUsed,
      solved: player.solved,
      relaySharedGuesses: room.relaySharedGuesses,
      relaySharedColors: room.relaySharedColors,
      relayTurnIndex: room.relayTurnIndex
    });

    io.to(roomCode).emit("room_updated", getSafeRoom(room));

    if (allPlayersDone(room)) {
      endRound(roomCode, SERVER_WORDS);
    }
  });

  // ── Use Hint ─────────────────────────────────────────────────────────────────
  socket.on("use_hint", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "playing" || room.gameMode !== "hint_mode") return;
    const player = room.players[socket.id];
    if (!player || player.score < 10) {
      return socket.emit("toast", { message: "❌ Not enough points for a hint!" });
    }

    player.score -= 10;
    player.hintsUsed++;

    // Find unrevealed correct positions
    const correctPositions = new Set();
    for (const g of player.guesses) {
      const c = checkGuess(g, room.word);
      for (let i = 0; i < 5; i++) {
        if (c[i] === "green") correctPositions.add(i);
      }
    }
    const candidates = [];
    for (let i = 0; i < 5; i++) {
      if (!correctPositions.has(i)) candidates.push(i);
    }

    if (candidates.length === 0) return;
    const pos = candidates[Math.floor(Math.random() * candidates.length)];

    socket.emit("hint_received", { position: pos, letter: room.word[pos] });
    io.to(roomCode).emit("score_updated", { playerId: socket.id, score: player.score });
    io.to(roomCode).emit("room_updated", getSafeRoom(room));
  });

  // ── Next Round (host only) ───────────────────────────────────────────────────
  socket.on("next_round", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.roundTimer) clearTimeout(room.roundTimer);
    if (room.currentRound < room.totalRounds) {
      room.currentRound++;
      startGame(roomCode, SERVER_WORDS);
    } else {
      room.phase = "gameover";
      const finalPlayers = Object.values(room.players).sort((a, b) => b.score - a.score);
      io.to(roomCode).emit("game_over", { players: finalPlayers });
      io.to(roomCode).emit("room_updated", getSafeRoom(room));
    }
  });

  // ── Restart Game ─────────────────────────────────────────────────────────────
  socket.on("restart_game", ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.timerInterval) clearInterval(room.timerInterval);
    if (room.roundTimer) clearTimeout(room.roundTimer);

    room.currentRound = 1;
    room.phase = "lobby";
    room.word = null;
    for (const player of Object.values(room.players)) {
      player.score = 0;
      player.guesses = [];
      player.colors = [];
      player.solved = false;
      player.attemptsUsed = 0;
      player.solvedAt = null;
      player.hintsUsed = 0;
      player.isReady = false;
      player.roundScore = 0;
    }
    io.to(roomCode).emit("room_updated", getSafeRoom(room));
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (!room.players[socket.id]) continue;

      const playerName = room.players[socket.id].name;
      delete room.players[socket.id];

      if (Object.keys(room.players).length === 0) {
        if (room.timerInterval) clearInterval(room.timerInterval);
        if (room.roundTimer) clearTimeout(room.roundTimer);
        delete rooms[code];
        break;
      }

      // Reassign host if needed
      if (room.hostId === socket.id) {
        room.hostId = Object.keys(room.players)[0];
      }

      io.to(code).emit("room_updated", getSafeRoom(room));
      io.to(code).emit("toast", { message: `👋 ${playerName} left the game` });

      // If game is playing and everyone is now done
      if (room.phase === "playing" && allPlayersDone(room)) {
        endRound(code, SERVER_WORDS);
      }
      break;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WordRush running on http://localhost:${PORT}`));
