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
const WORD_PROFILES = {
  pizza:    { shape: "round",   complexity: "medium" },
  airplane: { shape: "wide",    complexity: "high"   },
  cat:      { shape: "generic", complexity: "medium" },
  dog:      { shape: "generic", complexity: "medium" },
  computer: { shape: "wide",    complexity: "medium" },
  banana:   { shape: "tall",    complexity: "low"    },
  tree:     { shape: "tall",    complexity: "medium" },
  car:      { shape: "wide",    complexity: "medium" },
  house:    { shape: "tall",    complexity: "medium" },
  phone:    { shape: "tall",    complexity: "low"    },
  book:     { shape: "wide",    complexity: "low"    },
  guitar:   { shape: "tall",    complexity: "high"   },
  mountain: { shape: "generic", complexity: "medium" },
  river:    { shape: "wide",    complexity: "high"   },
  sun:      { shape: "round",   complexity: "low"    },
  moon:     { shape: "round",   complexity: "low"    },
  cloud:    { shape: "round",   complexity: "medium" },
  umbrella: { shape: "tall",    complexity: "medium" },
  cookie:   { shape: "round",   complexity: "medium" },
  pencil:   { shape: "tall",    complexity: "low"    },
  chair:    { shape: "tall",    complexity: "medium" },
  table:    { shape: "wide",    complexity: "medium" },
  flower:   { shape: "tall",    complexity: "high"   },
  rocket:   { shape: "tall",    complexity: "medium" },
  fish:     { shape: "wide",    complexity: "medium" },
  train:    { shape: "wide",    complexity: "high"   },
  shoe:     { shape: "wide",    complexity: "low"    },
  ball:     { shape: "round",   complexity: "low"    },
  camera:   { shape: "wide",    complexity: "medium" }
};

const ROUND_DURATION = 180;



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
  const baseColor = "#3b82f6";
  const lineWidth = 7;

  const W = 640;
  const H = 480;
  const cx = W / 2;
  const cy = H / 2;

  let currentColor = baseColor;

  function setColor(c) {
    currentColor = c || baseColor;
  }

  function penUp() {
    strokes.push({ type: "penUp" });
  }

  function penDown() {
    strokes.push({ type: "penDown" });
  }

  function addPoint(x, y) {
    strokes.push({
      type: "draw",
      x,
      y,
      color: currentColor,
      lineWidth
    });
  }

  function addLine(x1, y1, x2, y2, steps = 24) {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      addPoint(x, y);
    }
  }

  function addRectOutline(x, y, w, h) {
    addLine(x, y, x + w, y);
    addLine(x + w, y, x + w, y + h);
    addLine(x + w, y + h, x, y + h);
    addLine(x, y + h, x, y);
  }

  function addCircleOutline(xc, yc, r, segments = 32) {
    let prevX = xc + r;
    let prevY = yc;
    for (let i = 1; i <= segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      const x = xc + r * Math.cos(a);
      const y = yc + r * Math.sin(a);
      addLine(prevX, prevY, x, y, 1);
      prevX = x;
      prevY = y;
    }
  }

  function addArc(xc, yc, r, startAngle, endAngle, segments = 24) {
    let prevX = xc + r * Math.cos(startAngle);
    let prevY = yc + r * Math.sin(startAngle);
    for (let i = 1; i <= segments; i++) {
      const t = startAngle + ((endAngle - startAngle) * i) / segments;
      const x = xc + r * Math.cos(t);
      const y = yc + r * Math.sin(t);
      addLine(prevX, prevY, x, y, 1);
      prevX = x;
      prevY = y;
    }
  }

  function addWavyLine(x1, y1, x2, y2, waves = 4, amplitude = 15) {
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x1 + (x2 - x1) * t;
      const yBase = y1 + (y2 - y1) * t;
      const y = yBase + Math.sin(t * waves * Math.PI * 2) * amplitude;
      addPoint(x, y);
    }
  }

  function addSpiralFallback() {
    const baseRadius = 80;
    let radius = 10;
    penUp();
    penDown();
    for (let angle = 0; angle < Math.PI * 4; angle += 0.06) {
      const x = cx + radius * Math.cos(angle);
      const y = cy + radius * Math.sin(angle);
      addPoint(x, y);
      radius += (baseRadius - radius) * 0.02;
    }
    penUp();
  }

  // ------ Simple icons per word with explicit penUp/penDown ------

  function drawSun() {
    setColor("#facc15");
    penUp();
    penDown();
    addCircleOutline(cx, cy, 40);
    penUp();

    setColor("#f97316");
    const rayLen = 70;
    for (let i = 0; i < 8; i++) {
      const angle = (2 * Math.PI * i) / 8;
      const x1 = cx + 40 * Math.cos(angle);
      const y1 = cy + 40 * Math.sin(angle);
      const x2 = cx + rayLen * Math.cos(angle);
      const y2 = cy + rayLen * Math.sin(angle);
      penDown();
      addLine(x1, y1, x2, y2);
      penUp();
    }
  }

  function drawMoon() {
    setColor("#e5e7eb");
    penUp();
    penDown();
    addCircleOutline(cx, cy, 40);
    penUp();

    // simple crescent: second circle slightly offset
    setColor("#111827");
    penDown();
    addCircleOutline(cx + 15, cy, 40);
    penUp();
  }

  function drawBall() {
    setColor("#ef4444");
    penUp();
    penDown();
    addCircleOutline(cx, cy, 45);
    penUp();
  }

  function drawPizza() {
    const r = 80;
    const tipX = cx;
    const tipY = cy - r;
    const leftX = cx - r;
    const leftY = cy + r * 0.3;
    const rightX = cx + r;
    const rightY = cy + r * 0.3;

    setColor("#f97316");
    penUp();
    penDown();
    addLine(tipX, tipY, leftX, leftY);
    addLine(tipX, tipY, rightX, rightY);
    addLine(leftX, leftY, rightX, rightY);
    penUp();

    // pepperoni
    setColor("#b91c1c");
    penDown();
    addCircleOutline(cx - 20, cy - 10, 6, 10);
    penUp();
    penDown();
    addCircleOutline(cx + 15, cy, 6, 10);
    penUp();
    penDown();
    addCircleOutline(cx, cy + 15, 6, 10);
    penUp();
  }

  function drawHouse() {
    const w = 160;
    const h = 110;
    const baseX = cx - w / 2;
    const baseY = cy;

    setColor("#3b82f6"); // walls
    penUp();
    penDown();
    addRectOutline(baseX, baseY, w, h);
    penUp();

    setColor("#b91c1c"); // roof
    penDown();
    addLine(baseX, baseY, cx, baseY - 80);
    addLine(cx, baseY - 80, baseX + w, baseY);
    penUp();

    setColor("#4b5563"); // door
    penDown();
    addRectOutline(cx - 20, baseY + 40, 40, 70);
    penUp();
  }

  function drawTree() {
    // trunk
    setColor("#92400e");
    penUp();
    penDown();
    addRectOutline(cx - 15, cy + 10, 30, 80);
    penUp();

    // leaves
    setColor("#22c55e");
    penDown();
    addCircleOutline(cx, cy - 10, 40);
    penUp();
    penDown();
    addCircleOutline(cx - 25, cy, 30, 18);
    penUp();
    penDown();
    addCircleOutline(cx + 25, cy, 30, 18);
    penUp();
  }

  function drawCar() {
    const bodyW = 160;
    const bodyH = 50;
    const baseX = cx - bodyW / 2;
    const baseY = cy;

    setColor("#3b82f6");
    penUp();
    penDown();
    addRectOutline(baseX, baseY, bodyW, bodyH);
    penUp();

    // cabin
    penDown();
    addRectOutline(cx - 40, baseY - 30, 80, 30);
    penUp();

    // wheels
    setColor("#111827");
    penDown();
    addCircleOutline(cx - 60, baseY + bodyH + 18, 18, 16);
    penUp();
    penDown();
    addCircleOutline(cx + 60, baseY + bodyH + 18, 18, 16);
    penUp();
  }

  function drawTrain() {
    setColor("#3b82f6");
    penUp();
    penDown();
    addRectOutline(cx - 120, cy - 30, 60, 60);
    penUp();

    setColor("#10b981");
    penDown();
    addRectOutline(cx - 60, cy - 20, 60, 50);
    penUp();

    setColor("#f97316");
    penDown();
    addRectOutline(cx, cy - 30, 80, 60);
    penUp();

    // wheels
    setColor("#111827");
    const wheelY = cy + 40;
    const positions = [-95, -35, 25, 65];
    for (const dx of positions) {
      penDown();
      addCircleOutline(cx + dx, wheelY, 14, 12);
      penUp();
    }
  }

  function drawBook() {
    const w = 140;
    const h = 90;
    const baseX = cx - w / 2;
    const baseY = cy - h / 2;

    setColor("#10b981");
    penUp();
    penDown();
    addRectOutline(baseX, baseY, w, h);
    penUp();

    setColor("#111827");
    penDown();
    addLine(cx, baseY, cx, baseY + h);
    penUp();
  }

  function drawPhone() {
    const w = 80;
    const h = 150;
    const x = cx - w / 2;
    const y = cy - h / 2;

    setColor("#111827");
    penUp();
    penDown();
    addRectOutline(x, y, w, h);
    penUp();

    setColor("#0ea5e9");
    penDown();
    addRectOutline(x + 8, y + 12, w - 16, h - 40);
    penUp();
  }

  function drawCamera() {
    const w = 140;
    const h = 80;
    const x = cx - w / 2;
    const y = cy - h / 2;

    setColor("#374151");
    penUp();
    penDown();
    addRectOutline(x, y, w, h);
    penUp();

    setColor("#fbbf24");
    penDown();
    addCircleOutline(cx, cy, 28, 20);
    penUp();
  }

  function drawRocket() {
    const bodyW = 60;
    const bodyH = 160;
    const x = cx - bodyW / 2;
    const y = cy - bodyH / 2;

    setColor("#e5e7eb");
    penUp();
    penDown();
    addRectOutline(x, y, bodyW, bodyH);
    penUp();

    setColor("#ef4444");
    penDown();
    addLine(x, y, cx, y - 40);
    addLine(cx, y - 40, x + bodyW, y);
    penUp();
  }

  function drawFish() {
    const len = 140;
    const x1 = cx - len / 2;
    const x2 = cx + len / 2;
    const y = cy;

    setColor("#0ea5e9");
    penUp();
    penDown();
    addLine(x1, y, x2, y);
    penUp();

    // tail
    penDown();
    addLine(x2, y, x2 + 30, y - 20);
    addLine(x2, y, x2 + 30, y + 20);
    penUp();
  }

  function drawUmbrella() {
    const r = 80;
    setColor("#ec4899");
    penUp();
    penDown();
    addCircleOutline(cx, cy, r, 24);
    penUp();

    setColor("#111827");
    penDown();
    addLine(cx, cy, cx, cy + 80);
    penUp();
  }

  function drawFlower() {
    setColor("#facc15");
    penUp();
    penDown();
    addCircleOutline(cx, cy, 12, 12);
    penUp();

    setColor("#f97316");
    const petalR = 30;
    for (let i = 0; i < 6; i++) {
      const angle = (2 * Math.PI * i) / 6;
      const px = cx + petalR * Math.cos(angle);
      const py = cy + petalR * Math.sin(angle);
      penDown();
      addCircleOutline(px, py, 16, 16);
      penUp();
    }
  }

  function drawBanana() {
    const rOuter = 100;
    const rInner = 70;
    const start = -Math.PI / 4;
    const end = (5 * Math.PI) / 4;

    setColor("#facc15");
    penUp();
    penDown();
    addArc(cx, cy, rOuter, start, end, 22);
    penUp();

    setColor("#fbbf24");
    penDown();
    addArc(cx, cy + 20, rInner, start, end, 22);
    penUp();
  }

  function drawChair() {
    setColor("#6b7280");
    penUp();
    penDown();
    addRectOutline(cx - 40, cy - 40, 80, 40); // backrest
    penUp();

    setColor("#9ca3af");
    penDown();
    addRectOutline(cx - 40, cy, 80, 30); // seat
    penUp();
  }

  function drawTable() {
    setColor("#9ca3af");
    penUp();
    penDown();
    addRectOutline(cx - 100, cy - 20, 200, 40);
    penUp();

    setColor("#4b5563");
    penDown();
    addLine(cx - 80, cy + 20, cx - 80, cy + 80);
    addLine(cx + 80, cy + 20, cx + 80, cy + 80);
    penUp();
  }

  function drawCookie() {
    setColor("#eab308");
    penUp();
    penDown();
    addCircleOutline(cx, cy, 45, 24);
    penUp();

    setColor("#b45309");
    penDown();
    addCircleOutline(cx - 15, cy - 10, 4, 8);
    penUp();
    penDown();
    addCircleOutline(cx + 10, cy - 5, 4, 8);
    penUp();
  }

  function drawCloud() {
    setColor("#e5e7eb");
    penUp();
    penDown();
    addCircleOutline(cx - 35, cy, 35, 18);
    penUp();
    penDown();
    addCircleOutline(cx, cy - 15, 45, 18);
    penUp();
    penDown();
    addCircleOutline(cx + 35, cy, 35, 18);
    penUp();
  }

  function drawMountain() {
    setColor("#6b7280");
    penUp();
    penDown();
    addLine(cx - 120, cy + 70, cx, cy - 80);
    addLine(cx, cy - 80, cx + 120, cy + 70);
    penUp();
  }

  function drawRiver() {
    const leftX = cx - 150;
    const rightX = cx + 150;
    const topY = cy - 80;
    const bottomY = cy + 80;

    setColor("#0ea5e9");
    penUp();
    penDown();
    addWavyLine(leftX, topY, rightX, bottomY, 4, 20);
    penUp();
  }

  function drawCat() {
    setColor("#facc15");
    penUp();
    penDown();
    addCircleOutline(cx, cy, 40, 24); // head
    penUp();

    // ears
    setColor("#f59e0b");
    penDown();
    addLine(cx - 25, cy - 25, cx - 10, cy - 55);
    addLine(cx - 10, cy - 55, cx, cy - 25);
    penUp();
    penDown();
    addLine(cx + 25, cy - 25, cx + 10, cy - 55);
    addLine(cx + 10, cy - 55, cx, cy - 25);
    penUp();
  }

  function drawDog() {
    setColor("#9ca3af");
    penUp();
    penDown();
    addCircleOutline(cx, cy, 40, 24); // head
    penUp();

    // ears
    setColor("#6b7280");
    penDown();
    addRectOutline(cx - 45, cy - 15, 15, 35);
    penUp();
    penDown();
    addRectOutline(cx + 30, cy - 15, 15, 35);
    penUp();
  }

  function drawShoe() {
    const w = 180;
    const h = 40;
    const x = cx - w / 2;
    const y = cy;

    setColor("#ef4444");
    penUp();
    penDown();
    addLine(x, y, x + w, y);
    addLine(x, y, x, y + h);
    addLine(x + w, y, x + w - 20, y - h);
    addLine(x + w - 20, y - h, x + 20, y - h);
    penUp();
  }

  function drawGuitar() {
    // very simple: body + neck
    setColor("#f59e0b");
    penUp();
    penDown();
    addCircleOutline(cx - 20, cy, 30, 20);
    penUp();
    penDown();
    addCircleOutline(cx + 20, cy, 20, 20);
    penUp();

    // neck
    setColor("#6b7280");
    penDown();
    addRectOutline(cx + 30, cy - 10, 60, 20);
    penUp();
  }

  // ------- Choose which shape to draw -------

  if (word.includes("sun")) {
    drawSun();
  } else if (word.includes("moon")) {
    drawMoon();
  } else if (word.includes("ball")) {
    drawBall();
  } else if (word.includes("pizza")) {
    drawPizza();
  } else if (word.includes("house")) {
    drawHouse();
  } else if (word.includes("tree")) {
    drawTree();
  } else if (word.includes("car")) {
    drawCar();
  } else if (word.includes("train")) {
    drawTrain();
  } else if (word.includes("book")) {
    drawBook();
  } else if (word.includes("phone")) {
    drawPhone();
  } else if (word.includes("camera")) {
    drawCamera();
  } else if (word.includes("rocket")) {
    drawRocket();
  } else if (word.includes("fish")) {
    drawFish();
  } else if (word.includes("umbrella")) {
    drawUmbrella();
  } else if (word.includes("flower")) {
    drawFlower();
  } else if (word.includes("banana")) {
    drawBanana();
  } else if (word.includes("chair")) {
    drawChair();
  } else if (word.includes("table")) {
    drawTable();
  } else if (word.includes("cookie")) {
    drawCookie();
  } else if (word.includes("cloud")) {
    drawCloud();
  } else if (word.includes("mountain")) {
    drawMountain();
  } else if (word.includes("river")) {
    drawRiver();
  } else if (word.includes("cat")) {
    drawCat();
  } else if (word.includes("dog")) {
    drawDog();
  } else if (word.includes("shoe")) {
    drawShoe();
  } else if (word.includes("guitar")) {
    drawGuitar();
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
    
    // If this was a penUp, add extra delay before next stroke
    if (evt.type === "penUp") {
      i++; // skip next iteration to allow client to reset
    }
  }, 60);
}
// ---------- AI guessing helpers ----------

function maybeAIGuess(room) {
  if (!room.aiGuessingActive || !room.roundActive || !room.currentWord) return;

  const aiPlayer = room.players.find((p) => p.isAI);
  if (!aiPlayer) return;
  if (!room.currentWord) return;

  const drawer = room.players[room.drawerIndex];
  if (!drawer || drawer.id === aiPlayer.id) return;

  if (room.aiGuessCount == null) room.aiGuessCount = 0;
  
  const now = Date.now();
  if (room.aiGuessCount >= 6) return; // max guesses / round
  if (now - (room.aiLastGuessTime || 0) < 5000) return; // at most once per 5s

  if (!room.aiStrokeHistory || room.aiStrokeHistory.length < 40) return;

  const guess = computeAiGuessForRoom(room);
  if (!guess) return;

  room.aiGuessCount += 1;
  room.aiLastGuessTime = now;
  applyAiGuess(room, aiPlayer, guess);
}

function computeAiGuessForRoom(room) {
  if (!room || !room.currentWord) return null;

  const target = room.currentWord.toLowerCase();
  const len = target.length || 0;
  const mask = room.maskedWord || "";
  const diff = (room.aiDifficulty || "hard").toLowerCase();

  if (room.aiGuessCount == null) room.aiGuessCount = 0;
  const guessNumber = room.aiGuessCount + 1; // the guess we are about to make

  // ---------- EASY MODE ----------
  // First few guesses: completely random nonsense, *not* from WORDS.
  if (diff === "easy") {
    if (guessNumber <= 3) {
      // 🔹 first 3 guesses: nonsense words
      return randomNonsenseWord(len);
    } else {
      // After first few guesses, still fairly dumb:
      // pick random word from WORDS of correct length (ignoring mask).
      if (typeof WORDS !== "undefined" && Array.isArray(WORDS)) {
        let candidates = WORDS.filter(
          (w) => (w || "").length === len
        );
        if (candidates.length === 0) {
          candidates = WORDS.slice();
        }
        if (candidates.length > 0) {
          const idx = Math.floor(Math.random() * candidates.length);
          return candidates[idx];
        }
      }
      // fallback
      return randomNonsenseWord(len);
    }
  }

  // ---------- MEDIUM MODE ----------
  // Guesses are random, but:
  //   - always from WORDS
  //   - length matches the target word
  if (diff === "medium") {
    if (typeof WORDS !== "undefined" && Array.isArray(WORDS)) {
      // Start with words of the same length
      let candidates = WORDS.filter(
        (w) => (w || "").length === len
      );

      // Optionally: also respect revealed letters in the mask
      // (random among matching words)
      if (typeof filterWordsByMask === "function") {
        const filtered = filterWordsByMask(candidates, room);
        if (filtered && filtered.length > 0) {
          candidates = filtered;
        }
      }

      if (candidates.length === 0) {
        candidates = WORDS.slice(); // fallback to any word
      }

      if (candidates.length > 0) {
        const idx = Math.floor(Math.random() * candidates.length);
        return candidates[idx];
      }
    }
    // fallback if WORDS is not defined
    return randomNonsenseWord(len);
  }

  // ---------- HARD MODE (existing smarter logic) ----------
  // Keep your previous "smart" behavior for hard difficulty.
  // If you already had a decent version, you can paste it here.
  // Here’s a compact but still smart-ish version:

  const totalTime = typeof ROUND_DURATION === "number" ? ROUND_DURATION : 180;
  const elapsed =
    typeof room.roundTimeLeft === "number"
      ? Math.max(0, totalTime - room.roundTimeLeft)
      : 0;

  // Basic info score from mask
  let revealed = 0;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c !== "_" && c !== " ") revealed++;
  }
  const knownRatio = len > 0 ? revealed / len : 0;
  const timeRatio = Math.max(0, Math.min(1, elapsed / totalTime));
  const infoScore = Math.max(knownRatio, timeRatio);

  // Hard bot "cheat" probability – pretty strong
  const cheatBase = 0.45;
  const cheatGain = 0.55;
  const maxCheat = 0.98;

  const cheatProbability = Math.min(
    maxCheat,
    cheatBase + cheatGain * infoScore
  );

  if (Math.random() < cheatProbability) {
    // Knows the correct word
    return room.currentWord;
  }

  // Otherwise, pick the best-matching candidate from WORDS
  let candidates =
    typeof WORDS !== "undefined" && Array.isArray(WORDS)
      ? WORDS.slice()
      : [room.currentWord];

  if (typeof filterWordsByMask === "function") {
    const filtered = filterWordsByMask(candidates, room);
    if (filtered && filtered.length > 0) {
      candidates = filtered;
    }
  }

  if (!candidates || candidates.length === 0) {
    return room.currentWord;
  }

  function letterMatchScore(maskStr, w) {
    let s = 0;
    const L = Math.min(maskStr.length, w.length);
    for (let i = 0; i < L; i++) {
      const m = maskStr[i];
      if (m !== "_" && m !== " " && m === w[i]) s += 1;
    }
    return s;
  }

  let bestWord = null;
  let bestScore = -Infinity;
  for (const w of candidates) {
    let score = letterMatchScore(mask, w);
    if ((w || "").length === len) score += 0.5;
    if ((w || "").toLowerCase() === target) score += 2;
    score += Math.random() * 0.2;
    if (score > bestScore) {
      bestScore = score;
      bestWord = w;
    }
  }

  if (!bestWord) {
    bestWord = candidates[Math.floor(Math.random() * candidates.length)];
  }

  return bestWord;
}




function patternMatchScore(mask, word) {
  if (!mask || !word || word.length !== mask.length) return 0;

  // Build pattern of where letters repeat in the word
  const patternMap = {};
  const repeats = new Set();

  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (!patternMap[c]) patternMap[c] = [];
    patternMap[c].push(i);
  }

  for (const k in patternMap) {
    if (patternMap[k].length > 1) {
      for (const idx of patternMap[k]) repeats.add(idx);
    }
  }

  // Count how many repeated positions are already revealed in the mask
  let score = 0;
  repeats.forEach((idx) => {
    if (mask[idx] !== "_" && mask[idx] !== " ") {
      score += 0.5;
    }
  });

  return score;
}



function pickRandomWord(room) {
  const used = (room.aiUsedGuesses || []).map((w) => w.toLowerCase());
  const targetLen = room.currentWord ? room.currentWord.length : null;

  let pool = WORDS.slice();

  if (targetLen) {
    const sameLen = pool.filter((w) => w.length === targetLen);
    if (sameLen.length > 0) pool = sameLen;
  }

  // Avoid words already guessed this round
  const unused = pool.filter((w) => !used.includes(w.toLowerCase()));
  const finalPool = unused.length > 0 ? unused : pool;

  return finalPool[Math.floor(Math.random() * finalPool.length)];
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

  // Ensure tracker exists
  if (!room.aiUsedGuesses) {
    room.aiUsedGuesses = [];
  }

  if (g === room.currentWord) {
    // CORRECT GUESS
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
  } else {
    // WRONG GUESS → remember it so we don't try again
    if (!room.aiUsedGuesses.includes(g)) {
      room.aiUsedGuesses.push(g);
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
  room.aiUsedGuesses = []; // <--- reset used guesses each round


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
      aiLastGuessTime: 0,
      aiUsedGuesses: []  // <--- NEW: AI guesses already tried this round
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
  socket.on("addAIPlayer", ({ roomCode, difficulty }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return; // only host can add AI

    // For now only one AI
    if (room.players.some((p) => p.isAI)) return;

    const allowed = ["easy", "medium", "hard"];
    const diff =
      allowed.includes((difficulty || "").toLowerCase())
        ? difficulty.toLowerCase()
        : "medium";

    const pretty =
      diff.charAt(0).toUpperCase() + diff.slice(1); // Easy / Medium / Hard

    const aiPlayer = {
      id: `AI:${room.code}`,
      name: `AI Bot (${pretty})`,
      score: 0,
      isAI: true,
      difficulty: diff
    };

  // Store difficulty on the room for the AI guess logic
  room.aiDifficulty = diff;

  room.players.push(aiPlayer);
  broadcastPlayerList(room);
  broadcastScores(room);

  io.to(room.code).emit("chatMessage", {
    name: "System",
    text: `AI Bot (${pretty}) joined the room.`,
    type: "system"
  });
});


  room.players.push(aiPlayer);
  console.log(" -> AI Bot added. Total players:", room.players.length);
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
    
    // Allow game to start with just the host (at least 1 player total)
    if (room.players.length < 1) {  // ✓ Only 1 player (host) needed
      socket.emit("roomError", { message: "Need at least 1 player." });
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
