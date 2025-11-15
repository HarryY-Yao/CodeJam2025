const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

// -------- Game state per room --------

const rooms = {}; // roomCode -> roomState

const WORDS = [
  "pizza", "airplane", "cat", "dog", "computer", "banana", "tree", "car",
  "house", "phone", "book", "guitar", "mountain", "river", "sun",
  "moon", "cloud", "umbrella", "cookie", "pencil", "chair", "table",
  "flower", "rocket", "fish", "train", "shoe", "ball", "camera"
];

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function getRoom(code) {
  return rooms[code];
}

function getPlayer(room, socketId) {
  return room.players.find((p) => p.id === socketId);
}

function broadcastPlayerList(room) {
  const payload = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    isAI: !!p.isAI
  }));
  io.to(room.code).emit("playerListUpdate", payload);
}

function broadcastScores(room) {
  const scores = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score
  }));
  io.to(room.code).emit("scoresUpdate", { scores });
}

function revealRandomLetter(room) {
  const word = room.currentWord;
  let masked = room.maskedWord.split("");

  const indices = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== " " && masked[i] === "_") {
      indices.push(i);
    }
  }
  if (indices.length === 0) return;

  const idx = indices[Math.floor(Math.random() * indices.length)];
  masked[idx] = word[idx];
  room.maskedWord = masked.join("");
}

function stopTimers(room) {
  if (!room) return;
  if (room.roundTimer) {
    clearInterval(room.roundTimer);
    room.roundTimer = null;
  }
  if (room.aiDrawTimer) {
    clearInterval(room.aiDrawTimer);
    room.aiDrawTimer = null;
  }
}

function endRound(room, reason = "timeUp") {
  if (!room) return;
  room.roundActive = false;
  room.aiGuessingActive = false;
  stopTimers(room);

  const drawer = room.players[room.drawerIndex];
  const word = room.currentWord || "";
  const round = room.currentRound;

  const correctGuessers = room.correctGuessers.map((id) => {
    const p = room.players.find((pl) => pl.id === id);
    return p ? p.name : "?";
  });

  room.history.push({
    round,
    word,
    drawerName: drawer ? drawer.name : "?",
    correctGuessers
  });

  io.to(room.code).emit("roundEnded", {
    round,
    word,
    drawerName: drawer ? drawer.name : "?",
    correctGuessers,
    reason
  });

  // Short pause then next round or game over
  setTimeout(() => {
    if (!rooms[room.code]) return; // room might be deleted

    if (room.currentRound >= room.maxRounds) {
      const scores = room.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score
      }));
      io.to(room.code).emit("gameOver", {
        scores,
        history: room.history
      });
      return;
    }

    startNextRound(room);
  }, 3000);
}

function chooseWordOptions() {
  const options = [];
  while (options.length < 3) {
    const w = WORDS[Math.floor(Math.random() * WORDS.length)];
    if (!options.includes(w)) options.push(w);
  }
  return options;
}

// ---------- AI drawing helpers & word-specific templates ----------

function createAIStrokeSequence(wordRaw) {
  const word = (wordRaw || "").toLowerCase().trim();
  const strokes = [];
  const color = "#3b82f6";
  const lineWidth = 8;
  const W = 640;
  const H = 480;
  const cx = W / 2;
  const cy = H / 2;

  function addLine(x1, y1, x2, y2, steps = 30) {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      strokes.push({ type: "draw", x, y, color, lineWidth });
    }
  }

  function addCircle(cx, cy, r, segments = 60) {
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      strokes.push({ type: "draw", x, y, color, lineWidth });
    }
  }

  function addArc(cx, cy, r, startAngle, endAngle, segments = 40) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const a = startAngle + (endAngle - startAngle) * t;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      strokes.push({ type: "draw", x, y, color, lineWidth });
    }
  }

  function addRect(x, y, w, h) {
    addLine(x, y, x + w, y);
    addLine(x + w, y, x + w, y + h);
    addLine(x + w, y + h, x, y + h);
    addLine(x, y + h, x, y);
  }

  function addTriangle(x1, y1, x2, y2, x3, y3) {
    addLine(x1, y1, x2, y2);
    addLine(x2, y2, x3, y3);
    addLine(x3, y3, x1, y1);
  }

  function addWavyLine(x1, y1, x2, y2, waves = 10, amplitude = 20) {
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const yBase = y1 + (y2 - y1) * t;
      const y = yBase + Math.sin(t * waves * Math.PI * 2) * amplitude;
      strokes.push({ type: "draw", x, y, color, lineWidth });
    }
  }

  function addSpiralFallback() {
    const baseRadius = 80;
    let radius = 10;
    for (let angle = 0; angle < Math.PI * 4; angle += 0.06) {
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      strokes.push({ type: "draw", x, y, color, lineWidth });
      radius += (baseRadius / (Math.PI * 4)) * 0.06;
    }
  }

  // -------- Word-specific templates --------
  if (word.includes("sun")) {
    addCircle(cx, cy, 60);
    const rays = 12;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      const x1 = cx + 60 * Math.cos(a);
      const y1 = cy + 60 * Math.sin(a);
      const x2 = cx + 90 * Math.cos(a);
      const y2 = cy + 90 * Math.sin(a);
      addLine(x1, y1, x2, y2, 10);
    }

  } else if (word.includes("moon")) {
    addCircle(cx, cy, 70);
    addArc(cx + 20, cy - 5, 70, Math.PI * 0.3, Math.PI * 1.7);

  } else if (word.includes("house")) {
    const w = 200;
    const h = 140;
    const x = cx - w / 2;
    const y = cy - h / 2;
    addRect(x, y, w, h);
    addTriangle(x, y, x + w, y, cx, y - 90);
    addRect(cx - 25, cy, 50, 70);

  } else if (word.includes("tree")) {
    addRect(cx - 20, cy, 40, 90);
    addCircle(cx, cy - 40, 50);
    addCircle(cx - 40, cy - 10, 40);
    addCircle(cx + 40, cy - 10, 40);

  } else if (word.includes("flower")) {
    addCircle(cx, cy, 20);
    const petals = 8;
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2;
      const px = cx + 50 * Math.cos(a);
      const py = cy + 50 * Math.sin(a);
      addCircle(px, py, 20, 30);
    }
    addLine(cx, cy + 20, cx, cy + 120);
    addArc(cx - 25, cy + 60, 25, -Math.PI / 2, Math.PI / 2);
    addArc(cx + 25, cy + 60, 25, Math.PI / 2, (Math.PI * 3) / 2);

  } else if (word.includes("car")) {
    const bodyY = cy;
    addRect(cx - 120, bodyY - 40, 240, 80);
    addRect(cx - 60, bodyY - 80, 120, 40);
    addCircle(cx - 70, bodyY + 40, 30);
    addCircle(cx + 70, bodyY + 40, 30);

  } else if (word.includes("train")) {
    addRect(cx - 180, cy - 40, 80, 80);
    addRect(cx - 100, cy - 20, 80, 60);
    addRect(cx - 20, cy - 40, 100, 80);
    addRect(cx + 80, cy - 40, 100, 80);
    [cx - 160, cx - 80, cx, cx + 100].forEach((wx) => {
      addCircle(wx, cy + 50, 20, 25);
    });

  } else if (word.includes("fish")) {
    const bodyR = 70;
    addCircle(cx, cy, bodyR);
    addTriangle(cx + bodyR, cy, cx + bodyR + 50, cy - 30, cx + bodyR + 50, cy + 30);
    addCircle(cx - 25, cy - 10, 8, 20);

  } else if (word.includes("rocket")) {
    addRect(cx - 25, cy - 110, 50, 180);
    addTriangle(cx - 25, cy - 110, cx + 25, cy - 110, cx, cy - 160);
    addTriangle(cx - 25, cy + 70, cx - 60, cy + 110, cx - 25, cy + 110);
    addTriangle(cx + 25, cy + 70, cx + 60, cy + 110, cx + 25, cy + 110);
    addTriangle(cx - 15, cy + 110, cx + 15, cy + 110, cx, cy + 150);

  } else if (word.includes("camera")) {
    addRect(cx - 120, cy - 60, 240, 120);
    addCircle(cx, cy, 40);
    addRect(cx + 80, cy - 50, 40, 30);

  } else if (word.includes("pizza")) {
    const tipX = cx;
    const tipY = cy - 100;
    const leftX = cx - 80;
    const bottomY = cy + 100;
    const rightX = cx + 80;
    addTriangle(tipX, tipY, leftX, bottomY, rightX, bottomY);
    addArc(cx, bottomY, 80, Math.PI, 0);
    addCircle(cx - 20, cy, 10, 15);
    addCircle(cx + 20, cy - 20, 10, 15);
    addCircle(cx + 10, cy + 20, 10, 15);
    addCircle(cx - 25, cy + 20, 10, 15);

  } else if (word.includes("cat")) {
    addCircle(cx, cy, 70);
    addTriangle(cx - 40, cy - 40, cx - 10, cy - 90, cx - 70, cy - 80);
    addTriangle(cx + 40, cy - 40, cx + 10, cy - 90, cx + 70, cy - 80);
    addCircle(cx - 25, cy - 10, 8, 20);
    addCircle(cx + 25, cy - 10, 8, 20);
    addLine(cx - 20, cy + 10, cx - 80, cy, 15);
    addLine(cx - 20, cy + 20, cx - 80, cy + 30, 15);
    addLine(cx + 20, cy + 10, cx + 80, cy, 15);
    addLine(cx + 20, cy + 20, cx + 80, cy + 30, 15);

  } else if (word.includes("dog")) {
    addCircle(cx, cy, 70);
    addRect(cx - 70, cy - 20, 20, 80);
    addRect(cx + 50, cy - 20, 20, 80);
    addCircle(cx, cy + 20, 10, 20);

  } else if (word.includes("umbrella")) {
    addArc(cx, cy, 100, Math.PI, 0, 60);
    for (let i = 0; i < 5; i++) {
      const start = Math.PI + (i * Math.PI) / 5;
      const mid = start + Math.PI / 10;
      addArc(cx, cy, 100, start, mid, 8);
    }
    addLine(cx, cy, cx, cy + 150, 40);
    addArc(cx, cy + 150, 30, Math.PI, Math.PI * 1.5, 20);

  } else if (word.includes("ball")) {
    addCircle(cx, cy, 80);
    addLine(cx - 80, cy, cx + 80, cy, 30);
    addLine(cx, cy - 80, cx, cy + 80, 30);

  } else if (word.includes("phone")) {
    addRect(cx - 70, cy - 130, 140, 260);
    addCircle(cx, cy + 90, 10, 20);

  } else if (word.includes("book")) {
    addRect(cx - 120, cy - 80, 120, 160);
    addRect(cx, cy - 80, 120, 160);
    addLine(cx, cy - 80, cx, cy + 80, 40);

  } else if (word.includes("river")) {
    addWavyLine(0, cy - 40, W, cy + 40, 10, 40);

  } else if (word.includes("mountain")) {
    addTriangle(cx - 200, cy + 100, cx - 50, cy - 80, cx + 100, cy + 100);
    addTriangle(cx - 50, cy + 100, cx + 100, cy - 60, cx + 250, cy + 100);

  } else if (word.includes("chair")) {
    addRect(cx - 60, cy, 120, 40);
    addRect(cx - 60, cy - 100, 40, 100);
    addRect(cx + 20, cy - 100, 40, 100);
    addLine(cx - 60, cy + 40, cx - 60, cy + 90, 20);
    addLine(cx + 60, cy + 40, cx + 60, cy + 90, 20);

  } else if (word.includes("table")) {
    addRect(cx - 140, cy - 20, 280, 40);
    addLine(cx - 120, cy + 20, cx - 120, cy + 100, 30);
    addLine(cx + 120, cy + 20, cx + 120, cy + 100, 30);

  } else if (word.includes("shoe")) {
    addLine(cx - 120, cy + 40, cx + 80, cy + 40, 40);
    addArc(cx + 80, cy + 25, 15, Math.PI / 2, -Math.PI / 2, 20);
    addLine(cx + 80, cy + 10, cx - 60, cy - 20, 40);
    addLine(cx - 60, cy - 20, cx - 120, cy + 10, 40);

  } else if (word.includes("cloud")) {
    addCircle(cx - 50, cy, 40);
    addCircle(cx, cy - 20, 50);
    addCircle(cx + 50, cy, 40);

  } else if (word.includes("cookie")) {
    addCircle(cx, cy, 70);
    addCircle(cx - 20, cy - 10, 6, 10);
    addCircle(cx + 15, cy - 20, 6, 10);
    addCircle(cx + 10, cy + 15, 6, 10);
    addCircle(cx - 25, cy + 20, 6, 10);

  } else if (word.includes("banana")) {
    addArc(cx, cy, 100, Math.PI * 0.2, Math.PI * 0.8, 60);
    addArc(cx, cy + 30, 80, Math.PI * 0.2, Math.PI * 0.8, 60);

  } else if (word.includes("guitar")) {
    addCircle(cx - 20, cy + 40, 50);
    addCircle(cx + 40, cy + 10, 40);
    addRect(cx + 50, cy - 80, 20, 140);
    addLine(cx + 60, cy - 80, cx + 60, cy - 140, 20);

  } else {
    addSpiralFallback();
  }

  return strokes;
}

function startAIDrawing(room) {
  if (!room || !room.currentWord) return;
  const strokes = createAIStrokeSequence(room.currentWord);
  let i = 0;

  room.aiDrawTimer = setInterval(() => {
    if (!room.roundActive || i >= strokes.length) {
      clearInterval(room.aiDrawTimer);
      room.aiDrawTimer = null;
      return;
    }
    const evt = strokes[i++];
    io.to(room.code).emit("remoteDrawEvent", evt);
  }, 60);
}

// ---------- AI guessing helpers ----------

function maybeAIGuess(room) {
  if (!room.aiGuessingActive || !room.roundActive || !room.currentWord) return;

  const aiPlayer = room.players.find((p) => p.isAI);
  if (!aiPlayer) return;

  const drawer = room.players[room.drawerIndex];
  if (!drawer || drawer.id === aiPlayer.id) return;

  const now = Date.now();
  if (room.aiGuessCount >= 6) return; // max guesses / round
  if (now - (room.aiLastGuessTime || 0) < 5000) return; // at most once per 5s

  if (!room.aiStrokeHistory || room.aiStrokeHistory.length < 40) return;

  const guess = computeAiGuessForRoom(room);
  room.aiLastGuessTime = now;
  room.aiGuessCount++;

  applyAiGuess(room, aiPlayer, guess);
}

function computeAiGuessForRoom(room) {
  const strokes = room.aiStrokeHistory;
  if (!strokes || strokes.length === 0) {
    return pickRandomWord(room);
  }

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  for (const p of strokes) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const w = maxX - minX;
  const h = maxY - minY;

  if (w < 40 || h < 40) {
    return pickRandomWord(room);
  }

  const aspect = w / h;
  const area = w * h;

  let category = "generic";

  if (area > 50000 && aspect > 0.7 && aspect < 1.3) {
    category = "round";
  } else if (aspect > 1.4) {
    category = "wide";
  } else if (aspect < 0.7) {
    category = "tall";
  } else {
    category = "generic";
  }

  let candidates;
  if (category === "round") {
    candidates = ["sun", "moon", "ball", "cookie", "pizza"];
  } else if (category === "wide") {
    candidates = ["car", "train", "river", "table", "shoe", "camera"];
  } else if (category === "tall") {
    candidates = ["tree", "rocket", "flower", "guitar", "chair"];
  } else {
    candidates = WORDS.slice();
  }

  const filtered = filterWordsByMask(candidates, room);
  if (filtered.length > 0) {
    return filtered[Math.floor(Math.random() * filtered.length)];
  }

  return pickRandomWord(room);
}

function pickRandomWord(room) {
  const sameLen = WORDS.filter(
    (w) => w.length === room.currentWord.length
  );
  if (sameLen.length > 0) {
    return sameLen[Math.floor(Math.random() * sameLen.length)];
  }
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function filterWordsByMask(candidates, room) {
  const mask = room.maskedWord || "";
  if (!mask) return candidates.slice();

  const targetLen = room.currentWord.length;
  return candidates.filter((w) => {
    if (w.length !== targetLen) return false;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== "_" && mask[i] !== " " && mask[i] !== w[i]) return false;
    }
    return true;
  });
}

function applyAiGuess(room, aiPlayer, guessText) {
  const text = (guessText || "").trim();
  if (!text) return;

  io.to(room.code).emit("chatMessage", {
    name: aiPlayer.name,
    text,
    type: "chat"
  });

  if (!room.roundActive || !room.currentWord) return;

  const drawer = room.players[room.drawerIndex];
  if (!drawer || drawer.id === aiPlayer.id) return;

  if (room.correctGuessers.includes(aiPlayer.id)) return;

  const g = text.toLowerCase();
  if (g === room.currentWord) {
    room.correctGuessers.push(aiPlayer.id);
    aiPlayer.score += 10;
    drawer.score += 5;

    io.to(room.code).emit("chatMessage", {
      name: "System",
      text: `${aiPlayer.name} guessed the word!`,
      type: "system"
    });

    broadcastScores(room);

    if (room.correctGuessers.length >= room.players.length - 1) {
      endRound(room, "allGuessed");
    }
  }
}

// ---------- Round flow ----------

function startNextRound(room) {
  if (!room) return;

  stopTimers(room);
  room.currentRound += 1;
  room.roundActive = false;
  room.currentWord = null;
  room.maskedWord = null;
  room.correctGuessers = [];
  room.roundTimeLeft = 180;

  room.aiStrokeHistory = [];
  room.aiGuessingActive = false;
  room.aiGuessCount = 0;
  room.aiLastGuessTime = 0;

  if (room.currentRound === 1) {
    room.drawerIndex = 0;
  } else {
    room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
  }

  const drawer = room.players[room.drawerIndex];

  io.to(room.code).emit("roundPreparing", {
    round: room.currentRound,
    maxRounds: room.maxRounds,
    drawerName: drawer.name
  });

  if (drawer.isAI) {
    const options = chooseWordOptions();
    const chosen = options[0];
    startRoundWithWord(room, chosen, true);
  } else {
    const options = chooseWordOptions();
    io.to(drawer.id).emit("chooseWord", {
      roomCode: room.code,
      round: room.currentRound,
      maxRounds: room.maxRounds,
      options
    });
  }
}

function startRoundWithWord(room, wordRaw, fromAI = false) {
  const word = wordRaw.toLowerCase();
  room.currentWord = word;
  room.maskedWord = word.replace(/[a-z]/gi, (ch) => (ch === " " ? " " : "_"));
  room.correctGuessers = [];
  room.roundTimeLeft = 180;
  room.roundActive = true;

  room.aiStrokeHistory = [];
  room.aiGuessingActive = false;
  room.aiGuessCount = 0;
  room.aiLastGuessTime = 0;

  const drawer = room.players[room.drawerIndex];
  const hasAI = room.players.some((p) => p.isAI);

  if (hasAI && !drawer.isAI) {
    room.aiGuessingActive = true;
  }

  io.to(room.code).emit("roundInfo", {
    round: room.currentRound,
    maxRounds: room.maxRounds,
    drawerName: drawer.name,
    maskedWord: room.maskedWord
  });

  if (!drawer.isAI) {
    io.to(drawer.id).emit("yourWord", { word: wordRaw });
  }

  room.roundTimer = setInterval(() => {
    room.roundTimeLeft -= 1;
    if (room.roundTimeLeft < 0) room.roundTimeLeft = 0;

    io.to(room.code).emit("timerUpdate", { timeLeft: room.roundTimeLeft });

    if (
      (room.roundTimeLeft === 120 || room.roundTimeLeft === 60) &&
      room.roundActive
    ) {
      revealRandomLetter(room);
      io.to(room.code).emit("hintUpdate", {
        maskedWord: room.maskedWord
      });
    }

    maybeAIGuess(room);

    if (room.roundTimeLeft <= 0) {
      endRound(room, "timeUp");
    }
  }, 1000);

  if (drawer.isAI) {
    startAIDrawing(room);
  }
}

// -------- Socket.io --------

io.on("connection", (socket) => {
  console.log("Client connected", socket.id);

  socket.on("createRoom", ({ name }) => {
    let code;
    do {
      code = makeRoomCode();
    } while (rooms[code]);

    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name, score: 0, isAI: false }],
      maxRounds: 3,
      currentRound: 0,
      drawerIndex: 0,
      currentWord: null,
      maskedWord: null,
      correctGuessers: [],
      roundTimer: null,
      aiDrawTimer: null,
      roundTimeLeft: 0,
      roundActive: false,
      history: [],
      aiStrokeHistory: [],
      aiGuessingActive: false,
      aiGuessCount: 0,
      aiLastGuessTime: 0
    };

    rooms[code] = room;
    socket.join(code);

    socket.emit("roomCreated", {
      roomCode: code,
      players: room.players,
      isHost: true
    });
  });

  socket.on("joinRoom", ({ roomCode, name }) => {
    const code = (roomCode || "").toUpperCase();
    const room = getRoom(code);

    if (!room) {
      socket.emit("roomError", { message: "Room not found." });
      return;
    }

    if (room.players.find((p) => p.id === socket.id)) {
      socket.emit("roomError", { message: "You are already in this room." });
      return;
    }

    const player = { id: socket.id, name, score: 0, isAI: false };
    room.players.push(player);
    socket.join(code);

    socket.emit("roomJoined", {
      roomCode: code,
      players: room.players,
      isHost: room.hostId === socket.id
    });

    broadcastPlayerList(room);
    broadcastScores(room);

    io.to(code).emit("chatMessage", {
      name: "System",
      text: `${name} joined the room.`,
      type: "system"
    });
  });

  // Host adds AI player
  socket.on("addAIPlayer", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    if (room.players.some((p) => p.isAI)) return;

    const aiPlayer = {
      id: `AI:${room.code}`,
      name: "AI Bot",
      score: 0,
      isAI: true
    };

    room.players.push(aiPlayer);
    broadcastPlayerList(room);
    broadcastScores(room);

    io.to(room.code).emit("chatMessage", {
      name: "System",
      text: "AI Bot joined the room.",
      type: "system"
    });
  });

  socket.on("startGame", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;
    if (room.players.length < 2) {
      socket.emit("roomError", {
        message: "Need at least 2 players (human or AI) to start."
      });
      return;
    }

    room.currentRound = 0;
    room.history = [];
    room.players.forEach((p) => (p.score = 0));

    io.to(room.code).emit("gameStarted");
    broadcastScores(room);
    startNextRound(room);
  });

  socket.on("wordChosen", ({ roomCode, word }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const drawer = room.players[room.drawerIndex];
    if (!drawer || drawer.isAI) return;
    if (drawer.id !== socket.id) return;

    if (!word || typeof word !== "string") return;
    if (room.roundActive) return;

    startRoundWithWord(room, word, false);
  });

  socket.on("guessWord", ({ roomCode, guess }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const player = getPlayer(room, socket.id);
    if (!player) return;

    const text = (guess || "").trim();
    if (!text) return;

    io.to(room.code).emit("chatMessage", {
      name: player.name,
      text,
      type: "chat"
    });

    if (!room.roundActive || !room.currentWord) return;
    const drawer = room.players[room.drawerIndex];
    if (!drawer || drawer.id === socket.id) return;

    const alreadyGuessed = room.correctGuessers.includes(socket.id);
    if (alreadyGuessed) return;

    const g = text.toLowerCase();
    if (g === room.currentWord) {
      room.correctGuessers.push(socket.id);
      player.score += 10;
      drawer.score += 5;

      io.to(room.code).emit("chatMessage", {
        name: "System",
        text: `${player.name} guessed the word!`,
        type: "system"
      });

      broadcastScores(room);

      if (room.correctGuessers.length >= room.players.length - 1) {
        endRound(room, "allGuessed");
      }
    }
  });

  socket.on("drawEvent", ({ roomCode, event }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    // If current drawer is a human and this socket is the drawer, record strokes for AI analysis
    const drawer = room.players[room.drawerIndex];
    if (
      drawer &&
      !drawer.isAI &&
      drawer.id === socket.id &&
      event.type === "draw"
    ) {
      if (!room.aiStrokeHistory) room.aiStrokeHistory = [];
      room.aiStrokeHistory.push({ x: event.x, y: event.y });
      if (room.aiStrokeHistory.length > 1000) {
        room.aiStrokeHistory.shift();
      }
    }

    socket.to(roomCode).emit("remoteDrawEvent", event);
  });

  socket.on("clearCanvas", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    io.to(roomCode).emit("clearCanvasAll");
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected", socket.id);

    for (const code of Object.keys(rooms)) {
      const room = rooms[code];
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const [removed] = room.players.splice(idx, 1);

        io.to(code).emit("chatMessage", {
          name: "System",
          text: `${removed.name} left the room.`,
          type: "system"
        });

        if (room.players.length === 0) {
          stopTimers(room);
          delete rooms[code];
        } else {
          if (idx <= room.drawerIndex && room.drawerIndex > 0) {
            room.drawerIndex -= 1;
          }
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id;
          }
          broadcastPlayerList(room);
          broadcastScores(room);
        }
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
