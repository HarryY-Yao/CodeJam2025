// =================== SOCKET / ROOM SETUP ===================

const socket = io();

// Room state
let currentRoomCode = null;
let isHost = false;
let myPlayerName = "";
let players = [];

// Screens / UI
let roomScreen, lobbyScreen, gameScreen, endScreen;
let hostNameInput, joinNameInput, joinCodeInput;
let hostGameBtn, joinGameBtn, joinErrorEl;
let lobbyRoomCodeEl, lobbyPlayerListEl, lobbyRoleLabelEl;
let lobbyStartBtn, lobbyBackBtn, addAIBtn;

// Game UI
let roundInfoEl, currentPlayerLabel, timerValueEl, wordDisplayEl;
let guessFeedback, scoreList;
let finalSummary, finalScoreList, restartBtn;
let leaveGameBtn;

// Chat
let chatForm, chatInput, chatMessagesEl;

// Word choice overlay
let wordChoiceOverlay, wordChoiceRoundEl, wordChoiceOptionsEl;

// Canvas / camera
let canvas, ctx, landmarkCanvas, lctx, cameraVideo;
let clearCanvasBtn, lineWidthInput;
let colorSwatches, customColorInput, eraserBtn;

// Drawing state
let lastX = null;
let lastY = null;
let currentLineWidth = 8;
let currentColor = "#facc15";
const eraserRadius = 35;
let eraserActive = false;

// Round state
let currentRound = 1;
let maxRounds = 3;
let currentDrawerIndex = 0;
let roundActive = false;

// MediaPipe
let hands = null;
let camera = null;

// Gesture thresholds / cooldown
const COLOR_PINCH_THRESHOLD = 0.06;
const MODE_GESTURE_COOLDOWN = 800;
let lastModeChangeTime = 0;

// =================== DOM SETUP ===================

document.addEventListener("DOMContentLoaded", () => {
  // Screens
  roomScreen  = document.getElementById("room-screen");
  lobbyScreen = document.getElementById("lobby-screen");
  gameScreen  = document.getElementById("game-screen");
  endScreen   = document.getElementById("end-screen");

  // Room/lobby inputs
  hostNameInput = document.getElementById("join-name");
  joinNameInput = document.getElementById("join-name");
  joinCodeInput = document.getElementById("join-code");
  hostGameBtn   = document.getElementById("host-game-btn");
  joinGameBtn   = document.getElementById("join-game-btn");
  joinErrorEl   = document.getElementById("join-error");

  // Lobby UI
  lobbyRoomCodeEl   = document.getElementById("lobby-room-code");
  lobbyPlayerListEl = document.getElementById("lobby-player-list");
  lobbyRoleLabelEl  = document.getElementById("lobby-role-label");
  lobbyStartBtn     = document.getElementById("lobby-start-btn");
  lobbyBackBtn      = document.getElementById("lobby-back-btn");
  addAIBtn          = document.getElementById("add-ai-btn");

  // Game UI
  roundInfoEl        = document.getElementById("round-info");
  currentPlayerLabel = document.getElementById("current-player-label");
  timerValueEl       = document.getElementById("timer-value");
  wordDisplayEl      = document.getElementById("word-display");
  guessFeedback      = document.getElementById("guess-feedback");
  scoreList          = document.getElementById("score-list");

  // Chat
  chatForm       = document.getElementById("chat-form");
  chatInput      = document.getElementById("chat-input");
  chatMessagesEl = document.getElementById("chat-messages");

  // End screen
  finalSummary   = document.getElementById("final-summary");
  finalScoreList = document.getElementById("final-score-list");
  restartBtn     = document.getElementById("restart-btn");
  leaveGameBtn   = document.getElementById("leave-game-btn");

  // Canvas / camera
  cameraVideo    = document.getElementById("camera");
  canvas         = document.getElementById("drawCanvas");
  ctx            = canvas.getContext("2d");
  landmarkCanvas = document.getElementById("landmarkCanvas");
  lctx           = landmarkCanvas.getContext("2d");

  clearCanvasBtn = document.getElementById("clear-canvas-btn");
  lineWidthInput = document.getElementById("line-width");
  colorSwatches  = document.querySelectorAll(".color-swatch");
  customColorInput = document.getElementById("custom-color");
  eraserBtn        = document.getElementById("eraser-btn"); // optional in HTML

  currentLineWidth = parseInt(lineWidthInput.value, 10) || 8;

  // ===== Lobby / room listeners =====
  hostGameBtn.addEventListener("click", onHostGame);
  joinGameBtn.addEventListener("click", onJoinGame);
  lobbyBackBtn.addEventListener("click", () => window.location.reload());
  lobbyStartBtn.addEventListener("click", () => {
    if (!isHost || !currentRoomCode) return;
    socket.emit("startGame", { roomCode: currentRoomCode });
  });

  if (addAIBtn) {
    addAIBtn.addEventListener("click", () => {
      if (!isHost || !currentRoomCode) return;
      socket.emit("addAIPlayer", { roomCode: currentRoomCode });
    });
  }

  if (leaveGameBtn) {
    leaveGameBtn.addEventListener("click", () => {
      window.location.reload();
    });
  }

  // ===== Chat / guesses =====
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = (chatInput.value || "").trim();
    if (!text || !currentRoomCode) return;

    guessFeedback.textContent = `You guessed: ${text}`;
    socket.emit("guessWord", { roomCode: currentRoomCode, guess: text });
    chatInput.value = "";
  });

  restartBtn.addEventListener("click", () => {
    window.location.reload();
  });

  // ===== Canvas controls =====
  clearCanvasBtn.addEventListener("click", () => {
    clearDrawingCanvas();
    if (currentRoomCode) {
      socket.emit("clearCanvas", { roomCode: currentRoomCode });
    }
  });

  lineWidthInput.addEventListener("input", () => {
    currentLineWidth = parseInt(lineWidthInput.value, 10) || 8;
  });

  colorSwatches.forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveColor(btn.dataset.color || "#facc15");
    });
  });

  customColorInput.addEventListener("input", () => {
    setActiveColor(customColorInput.value);
  });

  setupSocketHandlers();
  startCameraAndHands();
});

// =================== ROOM / LOBBY ===================

function onHostGame() {
  const name = (hostNameInput.value || "").trim() || "Host";
  myPlayerName = name;
  socket.emit("createRoom", { name });
}

function onJoinGame() {
  const name = (joinNameInput.value || "").trim() || "Player";
  const code = (joinCodeInput.value || "").trim().toUpperCase();
  if (!code) {
    joinErrorEl.textContent = "Enter a room code.";
    return;
  }
  myPlayerName = name;
  joinErrorEl.textContent = "";
  socket.emit("joinRoom", { roomCode: code, name });
}

function updateLobbyPlayerList(list) {
  lobbyPlayerListEl.innerHTML = "";
  list.forEach((p) => {
    const li = document.createElement("li");
    let label = p.name;
    if (p.id === socket.id) label += " (You)";
    if (p.isAI) label += " [AI]";
    li.textContent = label;
    lobbyPlayerListEl.appendChild(li);
  });
}

function updateScoreUIFromServer(scoreArray) {
  scoreList.innerHTML = "";
  scoreArray.forEach((s) => {
    const li = document.createElement("li");
    const nameSpan = document.createElement("span");
    const scoreSpan = document.createElement("span");
    nameSpan.textContent = s.name;
    scoreSpan.textContent = `${s.score} pts`;
    li.appendChild(nameSpan);
    li.appendChild(scoreSpan);
    scoreList.appendChild(li);
  });
}

function logMessage(msg, cls) {
  const logEl = document.getElementById("message-log");
  if (!logEl) return;
  const p = document.createElement("p");
  if (cls) p.className = cls;
  p.textContent = msg;
  logEl.appendChild(p);
  logEl.scrollTop = logEl.scrollHeight;
}

// =================== SOCKET HANDLERS ===================

function amIDrawer() {
  const idx = players.indexOf(myPlayerName);
  return idx === currentDrawerIndex;
}

function setupSocketHandlers() {
  socket.on("roomCreated", ({ roomCode, players: pList, isHost: hostFlag }) => {
    currentRoomCode = roomCode;
    isHost = hostFlag;

    roomScreen.classList.add("hidden");
    lobbyScreen.classList.remove("hidden");

    lobbyRoomCodeEl.textContent = roomCode;
    lobbyRoleLabelEl.textContent = "You are the host.";
    lobbyStartBtn.disabled = false;
    if (addAIBtn) addAIBtn.disabled = false;

    players = pList.map((p) => p.name);
    updateLobbyPlayerList(pList);
  });

  socket.on("roomJoined", ({ roomCode, players: pList, isHost: hostFlag }) => {
    currentRoomCode = roomCode;
    isHost = hostFlag;

    roomScreen.classList.add("hidden");
    lobbyScreen.classList.remove("hidden");

    lobbyRoomCodeEl.textContent = roomCode;
    lobbyRoleLabelEl.textContent = isHost
      ? "You are the host."
      : "Waiting for host to start the game.";
    lobbyStartBtn.disabled = !isHost;
    if (addAIBtn) addAIBtn.disabled = !isHost;

    players = pList.map((p) => p.name);
    updateLobbyPlayerList(pList);
  });

  socket.on("roomError", ({ message }) => {
    joinErrorEl.textContent = message || "Error joining room.";
  });

  socket.on("playerListUpdate", (pList) => {
    players = pList.map((p) => p.name);
    updateLobbyPlayerList(pList);
  });

  socket.on("gameStarted", () => {
    lobbyScreen.classList.add("hidden");
    gameScreen.classList.remove("hidden");
    endScreen.classList.add("hidden");
    guessFeedback.textContent = "";
    clearDrawingCanvas();
    clearLandmarks();
  });

  socket.on("roundPreparing", ({ round, maxRounds: mr, drawerName }) => {
    currentRound = round;
    maxRounds = mr;
    roundInfoEl.textContent = `Round ${round} of ${mr}`;
    currentPlayerLabel.textContent = `Drawer: ${drawerName}`;
    wordDisplayEl.textContent = "Waiting for word...";
    guessFeedback.textContent = "";
    const logEl = document.getElementById("message-log");
    if (logEl) logEl.textContent = "";
  });

  socket.on("chooseWord", ({ roomCode, round, maxRounds: mr, options }) => {
    wordChoiceOverlay   = document.getElementById("word-choice-overlay");
    wordChoiceRoundEl   = document.getElementById("word-choice-round");
    wordChoiceOptionsEl = document.getElementById("word-choice-options");
    if (!wordChoiceOverlay) return;

    wordChoiceRoundEl.textContent = `Round ${round} of ${mr}`;
    wordChoiceOptionsEl.innerHTML = "";

    options.forEach((w) => {
      const btn = document.createElement("button");
      btn.textContent = w;
      btn.addEventListener("click", () => {
        socket.emit("wordChosen", { roomCode, word: w });
        wordChoiceOverlay.classList.add("hidden");
      });
      wordChoiceOptionsEl.appendChild(btn);
    });

    wordChoiceOverlay.classList.remove("hidden");
  });

  socket.on("roundInfo", ({ round, maxRounds: mr, drawerName, maskedWord }) => {
    currentRound = round;
    maxRounds = mr;
    currentDrawerIndex = players.indexOf(drawerName);
    roundInfoEl.textContent = `Round ${round} of ${mr}`;
    currentPlayerLabel.textContent = `Drawer: ${drawerName}`;
    wordDisplayEl.textContent = maskedWord;
    guessFeedback.textContent = "";
    const logEl = document.getElementById("message-log");
    if (logEl) logEl.textContent = "";
    clearDrawingCanvas();
    clearLandmarks();
    roundActive = true;
  });

  socket.on("yourWord", ({ word }) => {
    logMessage(`Your word is: ${word}`, "system");
  });

  socket.on("timerUpdate", ({ timeLeft }) => {
    timerValueEl.textContent = timeLeft;
  });

  socket.on("hintUpdate", ({ maskedWord }) => {
    wordDisplayEl.textContent = maskedWord;
  });

  socket.on("roundEnded", ({ round, word, drawerName, correctGuessers, reason }) => {
    roundActive = false;
    const msg =
      reason === "allGuessed"
        ? `Round ${round} ended. Everyone guessed "${word}".`
        : `Round ${round} ended. The word was "${word}".`;
    guessFeedback.textContent = msg;
    logMessage(msg, "system");
  });

  socket.on("gameOver", ({ scores, history }) => {
    roundActive = false;
    gameScreen.classList.add("hidden");
    endScreen.classList.remove("hidden");

    finalScoreList.innerHTML = "";
    const sorted = [...scores].sort((a, b) => b.score - a.score);
    const winner = sorted[0];
    finalSummary.textContent = winner
      ? `Winner: ${winner.name} with ${winner.score} points!`
      : "Game over.";

    sorted.forEach((s) => {
      const li = document.createElement("li");
      li.textContent = `${s.name}: ${s.score} pts`;
      finalScoreList.appendChild(li);
    });

    const logEl = document.getElementById("message-log");
    if (logEl) logEl.textContent = "";
    history.forEach((h) => {
      const line = `Round ${h.round}: "${h.word}" (drawer: ${h.drawerName}) – guessed by ${
        h.correctGuessers.join(", ") || "no one"
      }`;
      logMessage(line, "system");
    });
  });

  socket.on("scoresUpdate", ({ scores }) => {
    updateScoreUIFromServer(scores);
  });

  socket.on("chatMessage", ({ name, text, type }) => {
    const cls = type || "chat";
    const p = document.createElement("p");
    p.className = cls;
    const prefix = type === "system" ? "" : `${name}: `;
    p.textContent = prefix + text;
    chatMessagesEl.appendChild(p);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

    if (type !== "chat") {
      logMessage(prefix + text, cls);
    }
  });

  socket.on("remoteDrawEvent", (event) => {
    if (event.type === "draw") drawAtNetwork(event);
    if (event.type === "erase") eraseAtNetwork(event);
  });

  socket.on("clearCanvasAll", () => {
    clearDrawingCanvas();
  });
}

// =================== DRAWING HELPERS ===================

function clearDrawingCanvas() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  lastX = null;
  lastY = null;
}

function clearLandmarks() {
  if (!lctx) return;
  lctx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);
}

function setActiveColor(color) {
  currentColor = color;
  if (customColorInput) customColorInput.value = color;
  colorSwatches.forEach((b) => {
    b.classList.toggle("active", b.dataset.color === color);
  });
}

function cycleColorForward() {
  const colors = Array.from(colorSwatches).map((b) => b.dataset.color);
  if (colors.length === 0) return;
  const idx = colors.indexOf(currentColor);
  const nextIdx = idx === -1 ? 0 : (idx + 1) % colors.length;
  setActiveColor(colors[nextIdx]);
}

function drawAt(x, y) {
  if (!ctx) return;
  ctx.save();
  ctx.lineWidth = currentLineWidth;
  ctx.lineCap = "round";
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = currentColor;

  if (lastX == null || lastY == null) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  ctx.restore();
  lastX = x;
  lastY = y;
}

function eraseAt(x, y) {
  if (!ctx) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(x, y, eraserRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawEraserIndicator(x, y) {
  if (!lctx) return;
  lctx.save();
  lctx.strokeStyle = "#f97373";
  lctx.lineWidth = 2;
  lctx.beginPath();
  lctx.arc(x, y, eraserRadius, 0, Math.PI * 2);
  lctx.stroke();
  lctx.restore();
}

function sendDraw(x, y) {
  drawAt(x, y);
  if (!currentRoomCode || !amIDrawer()) return;
  socket.emit("drawEvent", {
    roomCode: currentRoomCode,
    event: {
      type: "draw",
      x,
      y,
      color: currentColor,
      lineWidth: currentLineWidth
    }
  });
}

function sendErase(x, y) {
  eraseAt(x, y);
  if (!currentRoomCode || !amIDrawer()) return;
  socket.emit("drawEvent", {
    roomCode: currentRoomCode,
    event: {
      type: "erase",
      x,
      y
    }
  });
}

function drawAtNetwork({ x, y, color, lineWidth }) {
  if (!ctx) return;
  ctx.save();
  ctx.lineWidth = lineWidth || currentLineWidth;
  ctx.lineCap = "round";
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = color || "#facc15";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 0.01, y + 0.01);
  ctx.stroke();
  ctx.restore();
}

function eraseAtNetwork({ x, y }) {
  eraseAt(x, y);
}

// =================== MEDIAPIPE HANDS ===================

function startCameraAndHands() {
  if (typeof Hands === "undefined" || typeof Camera === "undefined") {
    logMessage(
      "⚠ MediaPipe Hands not loaded. Gesture drawing disabled.",
      "system"
    );
    return;
  }

  if (hands) return;

  hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
  });

  hands.onResults(onHandsResults);

  camera = new Camera(cameraVideo, {
    onFrame: async () => {
      await hands.send({ image: cameraVideo });
    },
    width: 640,
    height: 480
  });

  camera.start().catch((err) => {
    console.error("Camera start error:", err);
    logMessage("⚠ Could not start camera. Check permissions.", "system");
  });
}

function onHandsResults(results) {
  clearLandmarks();

  // If no hand, reset state
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    lastX = null;
    lastY = null;
    eraserActive = false;
    if (eraserBtn) eraserBtn.classList.remove("eraser-active");
    return;
  }

  // 🔒 If you're not the drawer this round, you cannot draw or erase
  if (!roundActive || !amIDrawer()) {
    // Still show landmarks so they can see their hand, but no drawing logic
    const landmarks = results.multiHandLandmarks[0];

    if (
      typeof drawConnectors !== "undefined" &&
      typeof drawLandmarks !== "undefined" &&
      typeof HAND_CONNECTIONS !== "undefined"
    ) {
      drawConnectors(lctx, landmarks, HAND_CONNECTIONS, {
        color: "#22c55e",
        lineWidth: 3
      });
      drawLandmarks(lctx, landmarks, {
        color: "#f97316",
        lineWidth: 2
      });
    }

    lastX = null;
    lastY = null;
    eraserActive = false;
    if (eraserBtn) eraserBtn.classList.remove("eraser-active");
    return;
  }

  // ========= Drawer-only logic below =========
  const landmarks = results.multiHandLandmarks[0];

  if (
    typeof drawConnectors !== "undefined" &&
    typeof drawLandmarks !== "undefined" &&
    typeof HAND_CONNECTIONS !== "undefined"
  ) {
    drawConnectors(lctx, landmarks, HAND_CONNECTIONS, {
      color: "#22c55e",
      lineWidth: 3
    });
    drawLandmarks(lctx, landmarks, {
      color: "#f97316",
      lineWidth: 2
    });
  }

  const thumbTip  = landmarks[4];
  const indexTip  = landmarks[8];
  const middleTip = landmarks[12];
  const ringTip   = landmarks[16];
  const pinkyTip  = landmarks[20];

  const indexMcp  = landmarks[5];
  const middleMcp = landmarks[9];
  const ringMcp   = landmarks[13];
  const pinkyMcp  = landmarks[17];

  function tipAboveMcp(tip, mcp) {
    return tip.y < mcp.y - 0.02;
  }

  const indexUp  = tipAboveMcp(indexTip,  indexMcp);
  const middleUp = tipAboveMcp(middleTip, middleMcp);
  const ringUp   = tipAboveMcp(ringTip,   ringMcp);
  const pinkyUp  = tipAboveMcp(pinkyTip,  pinkyMcp);

  const dx = thumbTip.x - indexTip.x;
  const dy = thumbTip.y - indexTip.y;
  const pinchDist = Math.sqrt(dx * dx + dy * dy);
  const now = performance.now();

  // OK sign: thumb + index pinched, others straight -> change color
  const isColorPinch =
    pinchDist < COLOR_PINCH_THRESHOLD &&
    indexUp &&
    middleUp &&
    ringUp &&
    pinkyUp;

  if (isColorPinch && now - lastModeChangeTime > MODE_GESTURE_COOLDOWN) {
    lastModeChangeTime = now;
    cycleColorForward();
  }

  // Open hand (all 5 fingers extended, not pinching) -> erase
  const isOpenHand =
    indexUp &&
    middleUp &&
    ringUp &&
    pinkyUp &&
    pinchDist > COLOR_PINCH_THRESHOLD * 1.5;

  let mode = "none";

  // Draw: index only up
  if (indexUp && !middleUp && !ringUp && !pinkyUp && !isColorPinch) {
    mode = "draw";
    eraserActive = false;
    if (eraserBtn) eraserBtn.classList.remove("eraser-active");
  } else if (isOpenHand && !isColorPinch) {
    mode = "erase";
    eraserActive = true;
    if (eraserBtn) eraserBtn.classList.add("eraser-active");
  } else {
    mode = "none";
    lastX = null;
    lastY = null;
  }

  const x = indexTip.x * canvas.width;
  const y = indexTip.y * canvas.height;

  if (mode === "erase") {
    lastX = null;
    lastY = null;
    drawEraserIndicator(x, y);
    sendErase(x, y);
  } else if (mode === "draw") {
    sendDraw(x, y);
  } else {
    lastX = null;
    lastY = null;
  }
}

