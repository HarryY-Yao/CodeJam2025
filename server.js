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

// ---------- basic helpers ----------

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

  // short pause then next round or game over
  setTimeout(() => {
    if (!rooms[room.code]) return;

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

// ---------- AI drawing helpers & templates ----------

// ---------- AI drawing helpers & templates ----------

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

  function addEllipseOutline(xc, yc, rx, ry, segments = 32) {
    let prevX = xc + rx;
    let prevY = yc;
    for (let i = 1; i <= segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      const x = xc + rx * Math.cos(a);
      const y = yc + ry * Math.sin(a);
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

  // ---------- simple icons per word (good-looking versions) ----------

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
    addCircleOutline(cx, cy, 80);
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

    setColor("#3b82f6");
    penUp();
    penDown();
    addRectOutline(baseX, baseY, w, h);
    penUp();

    setColor("#b91c1c");
    penDown();
    addLine(baseX, baseY, cx, baseY - 80);
    addLine(cx, baseY - 80, baseX + w, baseY);
    penUp();

    setColor("#4b5563");
    penDown();
    addRectOutline(cx - 20, baseY + 40, 40, 70);
    penUp();
  }

  function drawTree() {
    setColor("#92400e");
    penUp();
    penDown();
    addRectOutline(cx - 15, cy + 10, 30, 80);
    penUp();

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

    penDown();
    addRectOutline(cx - 40, baseY - 30, 80, 30);
    penUp();

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

  // Airplane – vertical body with wings & tail
  function drawAirplane() {
    setColor("#e5e7eb");
    const bodyRx = 30;
    const bodyRy = 90;

    penUp();
    penDown();
    addEllipseOutline(cx, cy, bodyRx, bodyRy, 40);
    penUp();

    // Wings
    setColor("#6b7280");
    const wingY = cy;
    penDown();
    addLine(cx - 120, wingY, cx - 20, wingY - 10);
    addLine(cx - 20, wingY - 10, cx - 20, wingY + 10);
    addLine(cx - 20, wingY + 10, cx - 120, wingY);
    penUp();

    penDown();
    addLine(cx + 120, wingY, cx + 20, wingY - 10);
    addLine(cx + 20, wingY - 10, cx + 20, wingY + 10);
    addLine(cx + 20, wingY + 10, cx + 120, wingY);
    penUp();

    // Tail
    const tailY = cy + bodyRy;
    penDown();
    addLine(cx, tailY - 20, cx - 30, tailY + 30);
    addLine(cx - 30, tailY + 30, cx + 30, tailY + 30);
    addLine(cx + 30, tailY + 30, cx, tailY - 20);
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
  const len = 140;                 // overall body length
  const bodyLeft  = cx - len / 2;
  const bodyRight = cx + len / 2;
  const bodyTop   = cy - 25;
  const bodyBottom= cy + 25;

  setColor("#0ea5e9");

  // === BODY OUTLINE (big diamond) ===
  penUp();
  penDown();
  addLine(bodyLeft,  cy,      cx,        bodyTop);    // left -> top
  addLine(cx,        bodyTop, bodyRight, cy);         // top -> right
  addLine(bodyRight, cy,      cx,        bodyBottom); // right -> bottom
  addLine(cx,        bodyBottom, bodyLeft, cy);       // bottom -> left
  penUp();

  // === TAIL (small diamond on the left) ===
  const tailInnerX = bodyLeft - 15;
  const tailTipX   = bodyLeft - 40;
  const tailTop    = cy - 18;
  const tailBottom = cy + 18;

  penDown();
  addLine(bodyLeft,  cy,        tailInnerX, tailTop);
  addLine(tailInnerX, tailTop,  tailTipX,   cy);
  addLine(tailTipX,   cy,        tailInnerX, tailBottom);
  addLine(tailInnerX, tailBottom, bodyLeft,  cy);
  penUp();

  // === CENTER VERTICAL LINE ===
  penDown();
  addLine(cx, bodyTop, cx, bodyBottom);
  penUp();

  // === INNER HORIZONTAL LINE (spine) ===
  const spineLeft  = cx - len * 0.3;
  const spineRight = cx + len * 0.3;
  penDown();
  addLine(spineLeft, cy, spineRight, cy);
  penUp();

  // === EYE ===
  const eyeX = cx + len * 0.25;
  const eyeY = cy - 5;
  penDown();
  addArc(eyeX, eyeY, 3, 0, 2 * Math.PI, 8); // small circle
  penUp();
}


  // Umbrella – dome with scallops + handle
  function drawUmbrella() {
    const r = 110;
    const domeY = cy;

    // ==== TOP DOME (flip so it's not upside down) ====
    setColor("#ec4899");
    penUp();
    penDown();
    // Use 0 → PI so it arches up like ∩
    addArc(cx, domeY, r, 0, Math.PI, 40);
    penUp();

    // ==== SCALLOPED BOTTOM (no overlap, just touching) ====
    const scallopR = 25;
    // Distance between centers should be 2 * scallopR = 50
    // so they touch instead of overlapping.
    const offsets = [-75, -25, 25, 75]; // 4 bumps, 50px apart
    const bottomY = domeY + 10;

    for (const ox of offsets) {
      penDown();
      // Draw the bumps curving downward (∪)
      addArc(cx + ox, bottomY, scallopR, Math.PI, 2 * Math.PI, 12);
      penUp();
    }

    // ==== HANDLE ====
    setColor("#111827");
    const shaftTop = domeY + 10;
    const shaftBottom = shaftTop + 110;
    penDown();
    addLine(cx, shaftTop, cx, shaftBottom - 15);
    penUp();

    // Hook at bottom
    const hookR = 15;
    penDown();
    addArc(
      cx - hookR,
      shaftBottom - 15,
      hookR,
      Math.PI / 2,
      Math.PI * 1.3,
      12
    );
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

  // Banana – two parallel arcs
  function drawBanana() {
  const rOuter = 140;
  const rInner = 110;

  // Use a half-circle (bottom half, like a smile)
  const start = Math.PI;          // 180°
  const end = 2 * Math.PI;        // 360°

  // Pre-compute endpoints for both arcs
  const outerStart = {
    x: cx + rOuter * Math.cos(start),
    y: cy + rOuter * Math.sin(start),
  };
  const outerEnd = {
    x: cx + rOuter * Math.cos(end),
    y: cy + rOuter * Math.sin(end),
  };

  const innerCy = cy + 18; // keep inner arc slightly shifted down
  const innerStart = {
    x: cx + rInner * Math.cos(start),
    y: innerCy + rInner * Math.sin(start),
  };
  const innerEnd = {
    x: cx + rInner * Math.cos(end),
    y: innerCy + rInner * Math.sin(end),
  };

  // Outer half-circle
  setColor("#facc15");
  penUp();
  penDown();
  addArc(cx, cy, rOuter, start, end, 32);
  penUp();

  // Inner half-circle
  setColor("#fbbf24");
  penDown();
  addArc(cx, innerCy, rInner, start, end, 32);
  penUp();

  // Connect the ends with straight lines
  setColor("#facc15"); // or a darker outline if you prefer
  penDown();
  // Left side connection
  addLine(outerStart.x, outerStart.y, innerStart.x, innerStart.y);
  // Right side connection
  addLine(outerEnd.x, outerEnd.y, innerEnd.x, innerEnd.y);
  penUp();
}


  // Chair – side view (like the reference)
  function drawChair() {
    const seatY = cy + 20;
    const seatX1 = cx - 40;
    const seatX2 = cx + 10;

    setColor("#6b7280");
    penUp();
    penDown();
    // Seat
    addLine(seatX1, seatY, seatX2, seatY);
    // Front leg
    addLine(seatX1, seatY, seatX1, seatY + 80);
    // Back leg
    addLine(seatX2, seatY, seatX2, seatY + 90);
    // Backrest
    addLine(seatX2, seatY, seatX2, seatY - 80);
    penUp();
  }

  // Table – long top with two legs
  function drawTable() {
    const topY = cy;
    const leftX = cx - 150;
    const rightX = cx + 150;

    setColor("#4b5563");
    penUp();
    penDown();
    // Top
    addLine(leftX, topY, rightX, topY);
    penUp();

    // Legs
    const legHeight = 80;
    const legOffsets = [-80, 80];
    for (const offset of legOffsets) {
      const x = cx + offset;
      penDown();
      addLine(x, topY, x, topY + legHeight);
      penUp();
    }
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

  // Left side
  addLine(cx - 120, cy + 70, cx, cy - 80);
  // Right side
  addLine(cx, cy - 80, cx + 120, cy + 70);
  // Bottom side
  addLine(cx + 120, cy + 70, cx - 120, cy + 70);

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

  // Cat – circle head, ears, whiskers
  function drawCat() {
    setColor("#000000");
    const r = 60;

    // Head
    penUp();
    penDown();
    addCircleOutline(cx, cy, r, 40);
    penUp();

    // Ears (triangles)
    const earY = cy - r;
    const earHeight = 40;
    const earOffset = 35;

    penDown();
    addLine(cx - earOffset, earY, cx - earOffset / 2, earY - earHeight);
    addLine(cx - earOffset / 2, earY - earHeight, cx - earOffset / 4, earY);
    addLine(cx - earOffset / 4, earY, cx - earOffset, earY);
    penUp();

    penDown();
    addLine(cx + earOffset, earY, cx + earOffset / 2, earY - earHeight);
    addLine(cx + earOffset / 2, earY - earHeight, cx + earOffset / 4, earY);
    addLine(cx + earOffset / 4, earY, cx + earOffset, earY);
    penUp();

    // Eyes
    const eyeOffsetX = 18;
    const eyeY = cy - 5;
    penDown();
    addCircleOutline(cx - eyeOffsetX, eyeY, 3, 8);
    penUp();
    penDown();
    addCircleOutline(cx + eyeOffsetX, eyeY, 3, 8);
    penUp();

    // Whiskers
    const whiskerYOffsets = [-30, 0, 30];
    const whiskerLen = 45;
    for (const dy of whiskerYOffsets) {
      const y = cy + dy;
      penDown();
      addLine(cx - 8, y, cx - whiskerLen, y);
      penUp();
      penDown();
      addLine(cx + 8, y, cx + whiskerLen, y);
      penUp();
    }
  }

  // Dog – rectangle body + head + legs & tail (blocky dog)
  function drawDog() {
    setColor("#000000");

    const bodyW = 180;
    const bodyH = 80;
    const bodyX = cx - bodyW / 2;
    const bodyY = cy;

    // Body
    penUp();
    penDown();
    addRectOutline(bodyX, bodyY, bodyW, bodyH);
    penUp();

    // Head (square) on left
    const headSize = 70;
    const headX = bodyX;
    const headY = bodyY - headSize;
    penDown();
    addRectOutline(headX, headY, headSize, headSize);
    penUp();

    // Ears (triangles)
    const earTopY = headY;
    const earLeftX = headX + 10;
    const earRightX = headX + headSize - 10;

    penDown();
    addLine(earLeftX, earTopY, earLeftX + 10, earTopY - 25);
    addLine(earLeftX + 10, earTopY - 25, earLeftX + 20, earTopY);
    addLine(earLeftX + 20, earTopY, earLeftX, earTopY);
    penUp();

    penDown();
    addLine(earRightX, earTopY, earRightX - 10, earTopY - 25);
    addLine(earRightX - 10, earTopY - 25, earRightX - 20, earTopY);
    addLine(earRightX - 20, earTopY, earRightX, earTopY);
    penUp();

    // Legs
    const legWidth = 20;
    const legHeight = 40;
    const legOffsets = [-60, -20, 20, 60];
    for (const offset of legOffsets) {
      const lx = cx + offset - legWidth / 2;
      const ly = bodyY + bodyH;
      penDown();
      addRectOutline(lx, ly, legWidth, legHeight);
      penUp();
    }

    // Tail (triangle)
    const tailBaseX = bodyX + bodyW;
    const tailBaseY = bodyY + 20;
    penDown();
    addLine(tailBaseX, tailBaseY, tailBaseX + 40, tailBaseY - 15);
    addLine(tailBaseX + 40, tailBaseY - 15, tailBaseX, tailBaseY + 10);
    addLine(tailBaseX, tailBaseY + 10, tailBaseX, tailBaseY);
    penUp();
  }

  // Shoe – long base + angled top (matches ramp-ish picture)
  function drawShoe() {
    setColor("#000000");

    const baseY = cy + 40;
    const baseX1 = cx - 130;
    const baseX2 = cx + 80;

    // Base rectangle
    penUp();
    penDown();
    addRectOutline(baseX1, baseY - 25, baseX2 - baseX1, 25);
    penUp();

    // Heel (right vertical)
    const heelX = baseX2;
    const heelTopY = baseY - 80;
    penDown();
    addLine(heelX, baseY - 25, heelX, heelTopY);
    penUp();

    // Top diagonal up to a rim ellipse
    const rimCx = heelX;
    const rimCy = heelTopY;
    penDown();
    addLine(baseX1 + 20, baseY - 25, rimCx, rimCy);
    penUp();

    // Top ellipse (opening)
    penDown();
    addEllipseOutline(rimCx, rimCy, 45, 12, 28);
    penUp();
  }

  function drawGuitar() {
    setColor("#f59e0b");
    penUp();
    penDown();
    addCircleOutline(cx - 20, cy, 30, 20);
    penUp();
    penDown();
    addCircleOutline(cx + 20, cy, 20, 20);
    penUp();

    setColor("#6b7280");
    penDown();
    addRectOutline(cx + 30, cy - 10, 60, 20);
    penUp();
  }

  // Computer – monitor with inner frame + triangular stand
  function drawComputer() {
    setColor("#000000");

    const screenW = 260;
    const screenH = 140;
    const x = cx - screenW / 2;
    const y = cy - screenH / 2;

    // Outer frame
    penUp();
    penDown();
    addRectOutline(x, y, screenW, screenH);
    penUp();

    // Inner frame
    const innerPadding = 15;
    penDown();
    addRectOutline(
      x + innerPadding,
      y + innerPadding,
      screenW - 2 * innerPadding,
      screenH - 2 * innerPadding
    );
    penUp();

    // Stand
    const standTopX = cx;
    const standTopY = y + screenH;
    const standBottomY = standTopY + 60;
    const standHalf = 35;

    penDown();
    addLine(standTopX, standTopY, standTopX - standHalf, standBottomY);
    addLine(standTopX, standTopY, standTopX + standHalf, standBottomY);
    addLine(
      standTopX - standHalf,
      standBottomY,
      standTopX + standHalf,
      standBottomY
    );
    penUp();
  }

  // ---------- dispatch by word ----------

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
  } else if (word.includes("airplane")) {
    drawAirplane();
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
  } else if (word.includes("computer")) {
    drawComputer();
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
  }, 60);
}

// Debug helper: draw ALL AI templates one after another in a room
function debugDrawAllWords(room) {
  if (!room) return;
  const allWords = WORDS.slice();

  let index = 0;

  function drawNext() {
    if (index >= allWords.length) {
      io.to(room.code).emit("chatMessage", {
        name: "System",
        text: "✅ Finished drawing all AI words.",
        type: "system"
      });
      return;
    }

    const w = allWords[index++];
    io.to(room.code).emit("chatMessage", {
      name: "System",
      text: `🧪 Debug: drawing "${w}"`,
      type: "system"
    });

    io.to(room.code).emit("clearCanvasAll");

    const strokes = createAIStrokeSequence(w);
    let i = 0;

    const interval = setInterval(() => {
      if (i >= strokes.length) {
        clearInterval(interval);
        setTimeout(drawNext, 1200);
        return;
      }
      const evt = strokes[i++];
      io.to(room.code).emit("remoteDrawEvent", evt);
    }, 30);
  }

  drawNext();
}




// ---------- AI guessing helpers ----------

function randomNonsenseWord(targetLength) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const minLen = Math.max(3, targetLength || 4);
  const maxLen = Math.max(minLen, (targetLength || minLen) + 2);
  const len =
    minLen + Math.floor(Math.random() * (maxLen - minLen + 1));

  let w = "";
  for (let i = 0; i < len; i++) {
    w += letters[Math.floor(Math.random() * letters.length)];
  }

  const lower = w.toLowerCase();
  if (WORDS.some((x) => x.toLowerCase() === lower)) {
    return randomNonsenseWord(targetLength);
  }

  return w;
}

function maybeAIGuess(room) {
  if (!room.aiGuessingActive || !room.roundActive || !room.currentWord) return;

  const aiPlayer = room.players.find((p) => p.isAI);
  if (!aiPlayer) return;

  const drawer = room.players[room.drawerIndex];
  if (!drawer || drawer.id === aiPlayer.id) return;

  const now = Date.now();
  const diff = (room.aiDifficulty || "easy").toLowerCase();

  // Initial delay before the first guess
  const roundStart = room.roundStartTime || now;
  const elapsedMs = now - roundStart;
  const requiredDelayMs = diff === "medium" ? 5000 : 10000; // medium 5s, easy/hard 10s
  if (elapsedMs < requiredDelayMs) return;

  if (room.aiGuessCount == null) room.aiGuessCount = 0;

  // Limit total guesses per round
  if (room.aiGuessCount >= 6) return;

  // At most once every 5 seconds
  if (now - (room.aiLastGuessTime || 0) < 5000) return;

  // Require some strokes before guessing
  if (!room.aiStrokeHistory || room.aiStrokeHistory.length < 40) return;

  const guess = computeAiGuessForRoom(room);
  if (!guess) return;

  room.aiGuessCount += 1;
  room.aiLastGuessTime = now;
  applyAiGuess(room, aiPlayer, guess);
}

function pickRandomWord(room) {
  const used = (room.aiUsedGuesses || []).map((w) => w.toLowerCase());
  const targetLen = room.currentWord ? room.currentWord.length : null;

  let pool = WORDS.slice();

  if (targetLen) {
    const sameLen = pool.filter((w) => w.length === targetLen);
    if (sameLen.length > 0) pool = sameLen;
  }

  const unused = pool.filter((w) => !used.includes(w.toLowerCase()));
  const finalPool = unused.length > 0 ? unused : pool;

  return finalPool[Math.floor(Math.random() * finalPool.length)];
}

// intentionally pick a "bad" guess
function pickWorstWord(room) {
  if (!room || !room.currentWord || !Array.isArray(WORDS) || WORDS.length === 0) {
    return room && room.currentWord ? room.currentWord : null;
  }

  const target = room.currentWord.toLowerCase();
  const used = (room.aiUsedGuesses || []).map((g) => (g || "").toLowerCase());

  // Prefer words that:
  //  - are NOT the target
  //  - have a DIFFERENT length than the target
  //  - haven't been guessed before
  let pool = WORDS.filter((w) => {
    const lw = (w || "").toLowerCase();
    return (
      lw !== target &&
      !used.includes(lw) &&
      (w || "").length !== target.length
    );
  });

  // If we didn't find any "wrong length" words, take any other unused word
  if (pool.length === 0) {
    pool = WORDS.filter((w) => {
      const lw = (w || "").toLowerCase();
      return lw !== target && !used.includes(lw);
    });
  }

  // Absolute fallback
  if (pool.length === 0) {
    pool = WORDS.slice();
  }

  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

function patternMatchScore(mask, word) {
  if (!mask || !word || word.length !== mask.length) return 0;

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

  let score = 0;
  repeats.forEach((idx) => {
    if (mask[idx] !== "_" && mask[idx] !== " ") {
      score += 0.5;
    }
  });

  return score;
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

function computeAiGuessForRoom(room) {
  if (!room || !room.currentWord) return null;

  const diff = (room.aiDifficulty || "easy").toLowerCase();
  const target = room.currentWord.toLowerCase();
  const len = target.length || 0;
  const mask = room.maskedWord || "";

  if (room.aiGuessCount == null) room.aiGuessCount = 0;
  const guessNumber = room.aiGuessCount + 1;

  // Worst guesses phase:
  //  Easy: first 5 guesses
  //  Medium: first 3 guesses
  const inWorstPhase =
    (diff === "easy" && guessNumber <= 5) ||
    (diff === "medium" && guessNumber <= 3);

  if (inWorstPhase) {
    const worst = pickWorstWord(room);
    if (worst) return worst;
  }

  // Build candidate list for smart guesses
  let candidates =
    Array.isArray(WORDS) && WORDS.length > 0 ? WORDS.slice() : [target];

  if (len > 0) {
    const sameLen = candidates.filter((w) => (w || "").length === len);
    if (sameLen.length > 0) candidates = sameLen;
  }

  if (typeof filterWordsByMask === "function") {
    const filtered = filterWordsByMask(candidates, room);
    if (filtered && filtered.length > 0) {
      candidates = filtered;
    }
  }

  const used = (room.aiUsedGuesses || []).map((g) => (g || "").toLowerCase());
  candidates = candidates.filter(
    (w) => !used.includes((w || "").toLowerCase())
  );

  if (!candidates || candidates.length === 0) {
    candidates = Array.isArray(WORDS) && WORDS.length > 0 ? WORDS.slice() : [target];
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

  function combinedScore(maskStr, w) {
    let score = 0;
    score += letterMatchScore(maskStr, w);
    score += patternMatchScore(maskStr, w);
    if ((w || "").length === len) score += 0.5;
    if ((w || "").toLowerCase() === target) score += 2;
    return score;
  }

  function bestCandidate() {
    let bestWord = null;
    let bestScore = -Infinity;
    for (const w of candidates) {
      const sc = combinedScore(mask, w) + Math.random() * 0.2;
      if (sc > bestScore) {
        bestScore = sc;
        bestWord = w;
      }
    }
    return bestWord || candidates[0];
  }

  // Cheat probability per difficulty
  const totalTime = typeof ROUND_DURATION === "number" ? ROUND_DURATION : 180;
  const elapsed =
    typeof room.roundTimeLeft === "number"
      ? Math.max(0, totalTime - room.roundTimeLeft)
      : 0;

  let revealed = 0;
  for (let i = 0; i < mask.length; i++) {
    const c = mask[i];
    if (c !== "_" && c !== " ") revealed++;
  }
  const knownRatio = len > 0 ? revealed / len : 0;
  const timeRatio = Math.max(0, Math.min(1, elapsed / totalTime));
  const infoScore = Math.max(knownRatio, timeRatio);

  let cheatBase, cheatGain, maxCheat;

  if (diff === "easy") {
    cheatBase = 0.00;
    cheatGain = 0.01;
    maxCheat = 0.5;
  } else if (diff === "medium") {
    cheatBase = 0.00;
    cheatGain = 0.03;
    maxCheat = 0.8;
  } else {
    // hard
    cheatBase = 0.1;
    cheatGain = 0.05;
    maxCheat = 0.98;
  }

  const cheatProbability = Math.min(
    maxCheat,
    cheatBase + cheatGain * infoScore
  );

  if (Math.random() < cheatProbability) {
    return room.currentWord;
  }

  return bestCandidate();
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

  if (!room.aiUsedGuesses) {
    room.aiUsedGuesses = [];
  }

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
  } else {
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
  room.roundTimeLeft = ROUND_DURATION;

  room.aiStrokeHistory = [];
  room.aiGuessingActive = false;
  room.aiGuessCount = 0;
  room.aiLastGuessTime = 0;
  room.aiUsedGuesses = [];

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
  room.roundTimeLeft = ROUND_DURATION;
  room.roundActive = true;
  room.roundStartTime = Date.now();

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


    // Host-only debug: draw all AI words in sequence
  socket.on("debugDrawAllWords", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return; // host only
    debugDrawAllWords(room);
  });






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
      aiUsedGuesses: [],
      aiDifficulty: "easy"  // default difficulty = Easy
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
    const requested = (difficulty || "").toLowerCase();
    // default to easy if invalid / missing
    const diff = allowed.includes(requested) ? requested : "easy";

    room.aiDifficulty = diff;
    const pretty = diff.charAt(0).toUpperCase() + diff.slice(1);

    const aiPlayer = {
      id: `AI:${room.code}`,
      name: `AI Bot (${pretty})`,
      score: 0,
      isAI: true,
      difficulty: diff
    };

    room.players.push(aiPlayer);
    broadcastPlayerList(room);
    broadcastScores(room);

    io.to(room.code).emit("chatMessage", {
      name: "System",
      text: `AI Bot (${pretty}) joined the room.`,
      type: "system"
    });
  });

    socket.on("startGame", ({ roomCode, maxRounds }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    // Allow starting with just the host (>=1 player)
    if (room.players.length < 1) {
      socket.emit("roomError", { message: "Need at least 1 player." });
      return;
    }

    // ✅ sanitize and store chosen number of rounds
    let rounds = parseInt(maxRounds, 10);
    if (isNaN(rounds) || rounds < 1) rounds = 3;   // default if bad
    if (rounds > 20) rounds = 20;                  // cap to avoid absurd games

    room.maxRounds = rounds;

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

    // broadcast to everyone so all canvases stay in sync
    io.to(roomCode).emit("remoteDrawEvent", event);
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
