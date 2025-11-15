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
  let currentColor = "#3b82f6"; // default blue
  const lineWidth = 7;
  const W = 640;
  const H = 480;
  const cx = W / 2;
  const cy = H / 2;

  function setColor(color) {
    currentColor = color;
  }

  function addPoint(x, y) {
    strokes.push({ type: "draw", x, y, color: currentColor, lineWidth });
  }

  function addLine(x1, y1, x2, y2, segments = 12) {
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
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

  function addCircleOutline(xc, yc, r, segments = 28) {
    let prevX = xc + r;
    let prevY = yc;
    for (let i = 1; i <= segments; i++) {
      const theta = (2 * Math.PI * i) / segments;
      const x = xc + r * Math.cos(theta);
      const y = yc + r * Math.sin(theta);
      addLine(prevX, prevY, x, y, 1);
      prevX = x;
      prevY = y;
    }
  }

  function addArcSegment(xc, yc, r, startAngle, endAngle, segments = 18) {
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

  // === Simple icons per word, now with colors ===

  function drawSun() {
    setColor("#fbbf24"); // yellow
    addCircleOutline(cx, cy, 40);
    setColor("#f97316"); // orange rays
    const rayLen = 70;
    for (let i = 0; i < 8; i++) {
      const angle = (2 * Math.PI * i) / 8;
      const x1 = cx + 40 * Math.cos(angle);
      const y1 = cy + 40 * Math.sin(angle);
      const x2 = cx + rayLen * Math.cos(angle);
      const y2 = cy + rayLen * Math.sin(angle);
      addLine(x1, y1, x2, y2);
    }
  }

  function drawMoon() {
    setColor("#e5e7eb"); // light gray
    addCircleOutline(cx, cy, 40);
    const offset = 18;
    const r = 40;
    let prevX = cx + offset + r;
    let prevY = cy;
    for (let i = 1; i <= 22; i++) {
      const theta = (2 * Math.PI * i) / 22;
      const x = cx + offset + r * Math.cos(theta);
      const y = cy + r * Math.sin(theta);
      addLine(prevX, prevY, x, y, 1);
      prevX = x;
      prevY = y;
    }
  }

  function drawBall() {
    setColor("#ef4444"); // red ball
    addCircleOutline(cx, cy, 45);
    setColor("#111827");
    //addLine(cx - 45, cy, cx + 45, cy);
    //addLine(cx, cy - 45, cx, cy + 45);
  }

  function drawPizza() {
    const r = 80;
    const tipX = cx;
    const tipY = cy - r;
    const leftX = cx - r;
    const leftY = cy + r * 0.3;
    const rightX = cx + r;
    const rightY = cy + r * 0.3;

    setColor("#f97316"); // crust line
    addLine(tipX, tipY, leftX, leftY);
    addLine(tipX, tipY, rightX, rightY);
    addLine(leftX, leftY, rightX, rightY);

    // crust ridge
    setColor("#92400e");
    addLine(leftX, leftY, cx, leftY + 10);
    addLine(cx, leftY + 10, rightX, rightY);

    // toppings (pepperoni)
    setColor("#b91c1c");
    addCircleOutline(cx - 20, cy - 10, 6, 10);
    addCircleOutline(cx + 15, cy, 6, 10);
    addCircleOutline(cx, cy + 15, 6, 10);
  }

  function drawHouse() {
    const w = 160;
    const h = 110;
    const baseX = cx - w / 2;
    const baseY = cy;

    setColor("#3b82f6"); // blue walls
    addRectOutline(baseX, baseY, w, h);

    setColor("#b91c1c"); // red roof
    addLine(baseX, baseY, cx, baseY - 80);
    addLine(cx, baseY - 80, baseX + w, baseY);

    setColor("#4b5563"); // gray door
    addRectOutline(cx - 20, baseY + 40, 40, 70);
  }

  function drawTree() {
    // trunk
    setColor("#92400e");
    addRectOutline(cx - 15, cy + 10, 30, 80);

    // leaves
    setColor("#22c55e");
    addCircleOutline(cx, cy - 10, 40);
    addCircleOutline(cx - 25, cy, 30, 18);
    addCircleOutline(cx + 25, cy, 30, 18);
  }

  function drawCar() {
    const bodyW = 160;
    const bodyH = 50;
    const baseX = cx - bodyW / 2;
    const baseY = cy;

    setColor("#3b82f6"); // blue body
    addRectOutline(baseX, baseY, bodyW, bodyH);
    addRectOutline(cx - 40, baseY - 30, 80, 30); // cabin

    setColor("#111827"); // wheels
    addCircleOutline(cx - 60, baseY + bodyH + 18, 18, 16);
    addCircleOutline(cx + 60, baseY + bodyH + 18, 18, 16);
  }

  function drawTrain() {
    setColor("#3b82f6");
    addRectOutline(cx - 120, cy - 30, 60, 60);
    setColor("#10b981");
    addRectOutline(cx - 60, cy - 20, 60, 50);
    setColor("#f97316");
    addRectOutline(cx, cy - 30, 80, 60);

    setColor("#6b7280");
    addRectOutline(cx - 105, cy - 60, 20, 30); // chimney

    setColor("#111827");
    addCircleOutline(cx - 95, cy + 40, 14, 12);
    addCircleOutline(cx - 35, cy + 40, 14, 12);
    addCircleOutline(cx + 25, cy + 40, 14, 12);
    addCircleOutline(cx + 65, cy + 40, 14, 12);
  }

  function drawBook() {
    const w = 140;
    const h = 90;
    const baseX = cx - w / 2;
    const baseY = cy - h / 2;

    setColor("#10b981"); // green cover
    addRectOutline(baseX, baseY, w, h);

    setColor("#111827"); // spine & lines
    addLine(cx, baseY, cx, baseY + h);
    addLine(baseX + 10, baseY + 20, baseX + w - 10, baseY + 20);
    addLine(baseX + 10, baseY + 45, baseX + w - 10, baseY + 45);
  }

  function drawPhone() {
    const w = 80;
    const h = 150;
    const x = cx - w / 2;
    const y = cy - h / 2;

    setColor("#111827"); // dark outline
    addRectOutline(x, y, w, h);

    setColor("#0ea5e9"); // screen
    addRectOutline(x + 8, y + 12, w - 16, h - 40);

    setColor("#6b7280"); // button
    addCircleOutline(cx, y + h - 18, 5, 10);
  }

  function drawCamera() {
    const w = 140;
    const h = 80;
    const x = cx - w / 2;
    const y = cy - h / 2;

    setColor("#374151"); // body
    addRectOutline(x, y, w, h);

    setColor("#111827");
    addRectOutline(x + 10, y - 20, 50, 20); // top

    setColor("#fbbf24"); // lens
    addCircleOutline(cx, cy, 28, 20);

    setColor("#ef4444"); // small light
    addRectOutline(x + w - 30, y + 10, 15, 10);
  }

  function drawRocket() {
    const bodyW = 60;
    const bodyH = 160;
    const x = cx - bodyW / 2;
    const y = cy - bodyH / 2;

    setColor("#e5e7eb"); // light body
    addRectOutline(x, y, bodyW, bodyH);

    setColor("#ef4444"); // nose
    addLine(x, y, cx, y - 40);
    addLine(cx, y - 40, x + bodyW, y);

    setColor("#f97316"); // flames
    addLine(x, y + bodyH, x - 25, y + bodyH + 40);
    addLine(x + bodyW, y + bodyH, x + bodyW + 25, y + bodyH + 40);

    setColor("#0ea5e9"); // window
    addCircleOutline(cx, cy - 20, 12, 16);
  }

  function drawFish() {
    const len = 140;
    const x1 = cx - len / 2;
    const x2 = cx + len / 2;
    const y = cy;

    setColor("#0ea5e9"); // blue fish
    addLine(x1, y, x2, y);
    addLine(x1, y, cx - 20, y - 20);
    addLine(x1, y, cx - 20, y + 20);
    addLine(x2, y, x2 + 30, y - 20);
    addLine(x2, y, x2 + 30, y + 20);

    setColor("#111827");
    addCircleOutline(cx - 30, y - 8, 4, 8); // eye
  }

  function drawUmbrella() {
    const r = 80;
    setColor("#ec4899"); // pink canopy
    addCircleOutline(cx, cy, r, 24);
    addLine(cx - r, cy, cx + r, cy);

    setColor("#111827"); // handle
    addLine(cx, cy, cx, cy + 80);
    addArcSegment(cx, cy + 80, 18, Math.PI, Math.PI * 1.5, 10);
  }

  function drawFlower() {
    setColor("#facc15"); // center
    addCircleOutline(cx, cy, 12, 12);

    const petalR = 30;
    setColor("#f97316");
    for (let i = 0; i < 6; i++) {
      const angle = (2 * Math.PI * i) / 6;
      const px = cx + petalR * Math.cos(angle);
      const py = cy + petalR * Math.sin(angle);
      addCircleOutline(px, py, 16, 16);
    }

    setColor("#22c55e"); // stem & leaves
    addLine(cx, cy + 12, cx, cy + 80);
    addLine(cx, cy + 40, cx - 25, cy + 55);
    addLine(cx, cy + 55, cx - 10, cy + 65);
  }

  function drawBanana() {
    const rOuter = 100;
    const rInner = 70;
    const start = -Math.PI / 4;
    const end = (5 * Math.PI) / 4;

    setColor("#facc15");
    addArcSegment(cx, cy, rOuter, start, end, 22);

    setColor("#fbbf24");
    addArcSegment(cx, cy + 20, rInner, start, end, 22);
  }

  function drawPencil() {
    const len = 160;
    const x1 = cx - len / 2;
    const x2 = cx + len / 2;
    const y = cy;

    setColor("#facc15"); // body
    addLine(x1, y - 10, x2, y - 10);
    addLine(x1, y + 10, x2, y + 10);

    setColor("#6b7280"); // back
    addLine(x1, y - 10, x1, y + 10);

    setColor("#f97316"); // tip
    addLine(x2, y - 10, x2 + 25, y);
    addLine(x2, y + 10, x2 + 25, y);

    setColor("#111827"); // center line
    addLine(x1 + 10, y, x2 - 10, y);
  }

  function drawChair() {
    setColor("#6b7280");
    addRectOutline(cx - 40, cy - 40, 80, 40); // backrest

    setColor("#9ca3af");
    addRectOutline(cx - 40, cy, 80, 30); // seat

    setColor("#111827");
    addLine(cx - 35, cy + 30, cx - 35, cy + 80);
    addLine(cx + 35, cy + 30, cx + 35, cy + 80);
  }

  function drawTable() {
    setColor("#9ca3af");
    addRectOutline(cx - 100, cy - 20, 200, 40);
    setColor("#4b5563");
    addLine(cx - 80, cy + 20, cx - 80, cy + 80);
    addLine(cx + 80, cy + 20, cx + 80, cy + 80);
  }

  function drawCookie() {
    setColor("#eab308");
    addCircleOutline(cx, cy, 45, 24);

    setColor("#b45309"); // chips
    addCircleOutline(cx - 15, cy - 10, 4, 8);
    addCircleOutline(cx + 10, cy - 5, 4, 8);
    addCircleOutline(cx, cy + 15, 4, 8);
  }

  function drawCloud() {
    setColor("#e5e7eb"); // light gray cloud
    addCircleOutline(cx - 35, cy, 35, 18);
    addCircleOutline(cx, cy - 15, 45, 18);
    addCircleOutline(cx + 35, cy, 35, 18);
  }

  function drawMountain() {
    setColor("#6b7280");
    addLine(cx - 120, cy + 70, cx, cy - 80);
    addLine(cx, cy - 80, cx + 120, cy + 70);
    setColor("#9ca3af");
    addLine(cx - 40, cy + 70, cx + 40, cy + 70);
  }

  function drawRiver() {
    const leftX = cx - 150;
    const rightX = cx + 150;
    let prevX = leftX;
    let prevY = cy - 80;

    setColor("#0ea5e9");
    for (let i = 1; i <= 40; i++) {
      const t = i / 40;
      const x = leftX + (rightX - leftX) * t + Math.sin(t * Math.PI * 4) * 20;
      const y = cy - 80 + t * 160;
      addLine(prevX, prevY, x, y, 1);
      prevX = x;
      prevY = y;
    }
  }

  function drawComputer() {
    setColor("#111827");
    addRectOutline(cx - 120, cy - 80, 240, 140); // monitor

    setColor("#0ea5e9");
    addRectOutline(cx - 110, cy - 70, 220, 120); // screen

    setColor("#6b7280");
    addRectOutline(cx - 80, cy + 60, 160, 30); // base
    addLine(cx - 30, cy + 60, cx - 10, cy + 40);
    addLine(cx + 30, cy + 60, cx + 10, cy + 40);
  }

  function drawAirplane() {
    const bodyLen = 200;
    const x1 = cx - bodyLen / 2;
    const x2 = cx + bodyLen / 2;
    const y = cy;

    setColor("#e5e7eb");
    addLine(x1, y, x2, y); // body

    setColor("#3b82f6");
    addLine(cx - 20, y, cx - 80, y - 40);
    addLine(cx - 20, y, cx - 80, y + 40);
    addLine(cx + 40, y, cx, y - 40);
    addLine(cx + 40, y, cx, y + 40);

    setColor("#111827");
    addLine(x1, y, x1 - 30, y - 20);
    addLine(x1, y, x1 - 30, y + 20);
  }

  function drawCat() {
    setColor("#facc15"); // yellowish cat
    addCircleOutline(cx, cy, 40, 24); // head

    setColor("#f59e0b"); // ears
    addLine(cx - 25, cy - 25, cx - 10, cy - 55);
    addLine(cx - 10, cy - 55, cx, cy - 25);
    addLine(cx + 25, cy - 25, cx + 10, cy - 55);
    addLine(cx + 10, cy - 55, cx, cy - 25);

    setColor("#111827"); // whiskers
    addLine(cx - 10, cy + 10, cx - 40, cy + 10);
    addLine(cx - 10, cy + 15, cx - 40, cy + 20);
    addLine(cx + 10, cy + 10, cx + 40, cy + 10);
    addLine(cx + 10, cy + 15, cx + 40, cy + 20);
  }

  function drawDog() {
    setColor("#9ca3af"); // head
    addCircleOutline(cx, cy, 40, 24);

    setColor("#6b7280"); // ears
    addRectOutline(cx - 45, cy - 15, 15, 35);
    addRectOutline(cx + 30, cy - 15, 15, 35);

    setColor("#111827"); // mouth
    addLine(cx - 15, cy + 20, cx - 40, cy + 30);
    addLine(cx + 15, cy + 20, cx + 40, cy + 30);
  }

  function drawShoe() {
    const w = 180;
    const h = 40;
    const x = cx - w / 2;
    const y = cy;

    setColor("#ef4444"); // red shoe
    addLine(x, y, x + w, y);
    addLine(x, y, x, y + h);
    addLine(x + w, y, x + w - 20, y - h);
    addLine(x + w - 20, y - h, x + 20, y - h);
  }

  function drawGeneric() {
    // fallback: colored question mark
    setColor("#3b82f6");
    addCircleOutline(cx, cy - 30, 30, 20);
    setColor("#111827");
    addLine(cx + 10, cy, cx, cy + 30);
    addLine(cx, cy + 30, cx, cy + 50);
    addCircleOutline(cx, cy + 70, 3, 8);
  }

  // === Choose which icon to draw based on the word ===

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
  } else if (word.includes("pencil")) {
    drawPencil();
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
  } else if (word.includes("computer")) {
    drawComputer();
  } else if (word.includes("airplane")) {
    drawAirplane();
  } else if (word.includes("cat")) {
    drawCat();
  } else if (word.includes("dog")) {
    drawDog();
  } else if (word.includes("shoe")) {
    drawShoe();
  } else {
    drawGeneric();
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
  if (!room.currentWord) return null;

  const strokes = room.aiStrokeHistory || [];
  const mask = room.maskedWord || "";
  const used = (room.aiUsedGuesses || []).map((w) => w.toLowerCase());
  const target = room.currentWord.toLowerCase();
  const targetLen = room.currentWord.length;

  // ---------- 1. Info metrics (letters + time) ----------
  let revealed = 0;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c !== "_" && c !== " ") revealed++;
  }
  const knownRatio = targetLen > 0 ? revealed / targetLen : 0;

  const totalTime = ROUND_DURATION;
  const elapsed =
    typeof room.roundTimeLeft === "number"
      ? Math.max(0, totalTime - room.roundTimeLeft)
      : 0;
  const timeRatio = Math.max(0, Math.min(1, elapsed / totalTime));

  // ---------- 2. Aggressive "cheat" probability ----------
  // We want it to guess the correct word ASAP.
  // Baseline is already high; increases slightly with info.
  let baseCheat = 0.75; // 75% chance even at the very start

  // If there are some strokes, increase confidence
  if (strokes.length > 20) baseCheat = 0.85;
  if (strokes.length > 60) baseCheat = 0.92;

  // If a good chunk of letters is revealed, be almost certain
  if (knownRatio > 0.4) baseCheat = Math.max(baseCheat, 0.95);
  if (knownRatio > 0.7) baseCheat = Math.max(baseCheat, 0.98);

  // Slight bump over time, but it's already high from the start
  const cheatProbability = Math.min(0.99, baseCheat + timeRatio * 0.05);

  // If we decide to "cheat", just guess the correct word immediately
  if (!used.includes(target) && Math.random() < cheatProbability) {
    return room.currentWord; // fastest possible correct guess
  }

  // ---------- 3. Build candidate list based on mask & used guesses ----------
  let candidates = filterWordsByMask(WORDS, room); // matches length + mask
  candidates = candidates.filter((w) => !used.includes(w.toLowerCase()));

  // If no candidates left from mask, fall back to entire vocabulary minus used
  if (candidates.length === 0) {
    candidates = WORDS.filter((w) => !used.includes(w.toLowerCase()));
  }

  if (candidates.length === 0) {
    return null;
  }

  // If we have very few strokes and almost no letters, just pick random
  if (strokes.length < 30 && knownRatio < 0.2) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ---------- 4. Use drawing geometry (shape + complexity) to rank ----------
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
  const area = w > 0 && h > 0 ? w * h : 1;
  const pointCount = strokes.length;
  const density = pointCount / area;

  let strokeShape = "generic";
  if (w > 0 && h > 0) {
    const aspect = w / h;
    if (area > 50000 && aspect > 0.7 && aspect < 1.3) {
      strokeShape = "round";
    } else if (aspect > 1.4) {
      strokeShape = "wide";
    } else if (aspect < 0.7) {
      strokeShape = "tall";
    }
  }

  let strokeComplexity = "medium";
  if (density < 0.0002) strokeComplexity = "low";
  else if (density > 0.0007) strokeComplexity = "high";

  // ---------- 5. Score each candidate ----------
  let bestWord = null;
  let bestScore = -Infinity;

  for (const wrd of candidates) {
    const profile = WORD_PROFILES[wrd] || {
      shape: "generic",
      complexity: "medium"
    };

    let score = 0;

    // Shape match
    if (profile.shape === strokeShape) {
      score += 4;
    } else if (strokeShape === "generic" || profile.shape === "generic") {
      score += 1;
    } else {
      score -= 1;
    }

    // Complexity match
    if (profile.complexity === strokeComplexity) {
      score += 3;
    } else if (
      (strokeComplexity === "medium" && profile.complexity !== "medium") ||
      (profile.complexity === "medium" && strokeComplexity !== "medium")
    ) {
      score -= 0.5;
    } else {
      score -= 1;
    }

    // Repeated-letter pattern bonus (from the mask)
    if (mask) {
      const patternBonus = patternMatchScore(mask, wrd);
      score += patternBonus;
    }

    // Slight bias to shorter words early; longer words later
    if (wrd.length <= 4 && timeRatio < 0.5) score += 0.5;
    if (wrd.length >= 7 && timeRatio > 0.5) score += 0.5;

    // Small randomness so it doesn't behave identically every game
    score += Math.random() * 0.2;

    if (score > bestScore) {
      bestScore = score;
      bestWord = wrd;
    }
  }

  return bestWord || candidates[Math.floor(Math.random() * candidates.length)];
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
socket.on("addAIPlayer", ({ roomCode }) => {
  console.log("addAIPlayer requested by", socket.id, "for room", roomCode);
  const room = getRoom(roomCode);
  if (!room) {
    console.log(" -> room not found");
    return;
  }
  if (room.hostId !== socket.id) {
    console.log(" -> rejected: not host (hostId is", room.hostId, ")");
    return;
  }

  if (room.players.some((p) => p.isAI)) {
    console.log(" -> AI already present");
    return;
  }

  const aiPlayer = {
    id: `AI:${room.code}`,
    name: "AI Bot",
    score: 0,
    isAI: true
  };

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
