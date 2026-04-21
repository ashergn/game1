const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const rooms = new Map();
const adminTokens = new Map(); // token -> { type: 'global'|'room', roomId? }
const TARGET_IMAGE_POOL_SIZE = 120;
const FALLBACK_IMAGE_POOL_SIZE = 180;
const WIKIMEDIA_PAGE_LIMIT = 50;
const WIKIMEDIA_MAX_PAGES = 8;
const TOTAL_ROUNDS = 5;
const MANAGER_PREVIEW_IMAGE_COUNT = 3;
const DEFAULT_ROUND_DURATION_SEC = 60;
const MIN_ROUND_DURATION_SEC = 10;
const MAX_ROUND_DURATION_SEC = 600;

const roundTimers = new Map();

function createRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function normalizeWord(word) {
  return (word || "")
    .toString()
    .normalize("NFKD")
    .replace(/[\u0591-\u05C7]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizePair(wordA, wordB) {
  return [normalizeWord(wordA), normalizeWord(wordB)].sort().join("|");
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseTwoWordDescription(input) {
  const words = normalizeWord(input)
    .split(" ")
    .filter(Boolean);
  if (words.length !== 2) {
    return null;
  }
  return words;
}

function buildFallbackImages(subject) {
  const safe = (subject || "random").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "random";
  const salt = Date.now().toString(36);
  const pool = Array.from({ length: FALLBACK_IMAGE_POOL_SIZE }, () => {
    const r = Math.random().toString(36).slice(2, 8);
    return `https://picsum.photos/seed/${safe}-${salt}-${r}/900/600`;
  });
  return shuffleArray(pool);
}

async function translateToEnglish(text) {
  const source = (text || "").trim();
  if (!source) {
    return "";
  }

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(source)}`;

  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      return "";
    }

    const data = await response.json();
    const translated = Array.isArray(data?.[0])
      ? data[0].map((part) => part?.[0] || "").join("").trim()
      : "";

    return translated;
  } catch (_error) {
    return "";
  }
}

async function fetchSubjectImages(subject, targetSize = TARGET_IMAGE_POOL_SIZE) {
  const query = (subject || "").trim();
  if (!query) {
    return [];
  }

  const collected = new Set();
  let gsrcontinue = "";
  let pagesFetched = 0;

  try {
    while (pagesFetched < WIKIMEDIA_MAX_PAGES && collected.size < targetSize) {
      const params = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: `${query} filetype:bitmap`,
        gsrnamespace: "6",
        gsrlimit: String(WIKIMEDIA_PAGE_LIMIT),
        prop: "imageinfo",
        iiprop: "url",
        iiurlwidth: "1400",
        format: "json",
        origin: "*"
      });

      if (gsrcontinue) {
        params.set("gsrcontinue", gsrcontinue);
      }

      const endpoint = `https://commons.wikimedia.org/w/api.php?${params.toString()}`;
      const response = await fetch(endpoint, { method: "GET" });
      if (!response.ok) {
        break;
      }

      const data = await response.json();
      const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
      for (const p of pages) {
        const imageUrl = p?.imageinfo?.[0]?.thumburl || p?.imageinfo?.[0]?.url;
        if (imageUrl) {
          collected.add(imageUrl);
        }
      }

      pagesFetched += 1;
      gsrcontinue = data?.continue?.gsrcontinue || "";
      if (!gsrcontinue) {
        break;
      }
    }

    return shuffleArray([...collected]);
  } catch (_error) {
    return [];
  }
}

async function buildImagesForSubject(subject) {
  const cleaned = (subject || "").trim();
  if (!cleaned) {
    return buildFallbackImages("random");
  }

  const translated = await translateToEnglish(cleaned);
  const queries = [cleaned];
  if (translated && translated.toLowerCase() !== cleaned.toLowerCase()) {
    queries.push(translated);
  }

  let related = [];
  for (const query of queries) {
    const urls = await fetchSubjectImages(query, TARGET_IMAGE_POOL_SIZE);
    related = [...related, ...urls];
    related = [...new Set(related)];
    if (related.length >= TARGET_IMAGE_POOL_SIZE) {
      break;
    }
  }

  if (related.length >= 3) {
    return shuffleArray(related);
  }

  return buildFallbackImages(cleaned);
}

function refillUnusedImages(room) {
  room.unusedImages = shuffleArray(room.images || []);
}

function pickRandomImage(room, avoidUrl) {
  if (!Array.isArray(room.unusedImages) || room.unusedImages.length === 0) {
    refillUnusedImages(room);
  }

  const blocked = new Set(
    (Array.isArray(avoidUrl) ? avoidUrl : [avoidUrl]).filter(Boolean)
  );

  let nextIndex = room.unusedImages.findIndex((url) => url && !blocked.has(url));
  if (nextIndex === -1) {
    refillUnusedImages(room);
    nextIndex = room.unusedImages.findIndex((url) => url && !blocked.has(url));
  }

  if (nextIndex !== -1) {
    const [picked] = room.unusedImages.splice(nextIndex, 1);
    return picked;
  }

  return buildFallbackImages(room.subject || "random")[0];
}

function pickRoundImages(room, count, avoidUrls = []) {
  const images = [];
  const blocked = new Set((avoidUrls || []).filter(Boolean));

  while (images.length < count) {
    const nextImage = pickRandomImage(room, [...blocked, ...images]);
    if (!nextImage || blocked.has(nextImage) || images.includes(nextImage)) {
      const fallback = buildFallbackImages(`${room.subject || "random"}-${images.length}`)[0];
      if (!fallback || blocked.has(fallback) || images.includes(fallback)) {
        break;
      }
      images.push(fallback);
      continue;
    }

    images.push(nextImage);
  }

  return images;
}

function getActiveImageCount(playerCount) {
  if (playerCount >= 7) {
    return 3;
  }
  if (playerCount >= 4) {
    return 2;
  }
  return 1;
}

function getImageDistributionCounts(playerCount, imageCount) {
  const counts = Array.from({ length: MANAGER_PREVIEW_IMAGE_COUNT }, () => 0);
  if (imageCount <= 1) {
    counts[0] = playerCount;
    return counts;
  }

  for (let index = 0; index < playerCount; index += 1) {
    counts[index % imageCount] += 1;
  }

  return counts;
}

function assignPlayersToImages(playerIds, imageCount) {
  const shuffledIds = shuffleArray(playerIds || []);
  const assignments = {};

  shuffledIds.forEach((playerId, index) => {
    assignments[playerId] = imageCount <= 1 ? 0 : index % imageCount;
  });

  return assignments;
}

function prepareManagerPreview(room, avoidUrls = []) {
  room.roundImageUrls = pickRoundImages(room, MANAGER_PREVIEW_IMAGE_COUNT, avoidUrls);
  room.activeImageCount = getActiveImageCount(room.players.length);
  room.currentImageUrl = room.roundImageUrls[0] || null;
}

function emitManagerPreview(room, socketId) {
  if (!room.hostId) {
    return;
  }

  room.activeImageCount = getActiveImageCount(room.players.length);

  const target = socketId
    ? io.to(socketId)
    : io.to(room.hostId);

  target.emit("showManagerImages", {
    imageUrls: room.roundImageUrls || [],
    subject: room.subject,
    activeImageCount: room.activeImageCount || 1,
    playerCount: room.players.length,
    distributionCounts: getImageDistributionCounts(room.players.length, room.activeImageCount || 1)
  });
}

function getPublicRoomState(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    subject: room.subject,
    started: room.started,
    playerCount: room.players.length,
    players: room.players.map((p) => ({ id: p.id, name: p.name })),
    roundIndex: room.roundIndex,
    roundActive: !!room.roundActive,
    roundDurationSec: room.roundDurationSec || DEFAULT_ROUND_DURATION_SEC,
    roundEndsAt: room.roundEndsAt || null,
    totalRounds: TOTAL_ROUNDS,
    pairPoints: room.pairPoints,
    scores: room.players
      .map((p) => ({ id: p.id, name: p.name, points: room.scores[p.id] || 0 }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "he")),
    roundWinners: room.roundWinners || {}
  };
}

function clearRoundTimer(room) {
  const timer = roundTimers.get(room.id);
  if (timer) {
    clearTimeout(timer);
    roundTimers.delete(room.id);
  }
  room.roundEndsAt = null;
}

function scheduleRoundTimer(room) {
  clearRoundTimer(room);
  const durationSec = room.roundDurationSec || DEFAULT_ROUND_DURATION_SEC;
  room.roundEndsAt = Date.now() + (durationSec * 1000);

  const timer = setTimeout(() => {
    const liveRoom = rooms.get(room.id);
    if (!liveRoom || !liveRoom.roundActive) {
      return;
    }
    finalizeRound(liveRoom, { requireAllSubmitted: false, reason: "timeout" });
  }, durationSec * 1000);

  roundTimers.set(room.id, timer);
}

function emitRoomState(room) {
  io.to(room.id).emit("roomState", getPublicRoomState(room));
}

function emitRound(room) {
  if (room.roundIndex >= TOTAL_ROUNDS) {
    const sortedScores = room.players
      .map((p) => ({ name: p.name, points: room.scores[p.id] || 0 }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "he"));
    io.to(room.id).emit("gameOver", {
      scores: sortedScores,
      pairPoints: room.pairPoints,
      totalRounds: TOTAL_ROUNDS
    });
    return;
  }

  const assignments = room.playerImageAssignments || {};
  room.players.forEach((player) => {
    const imageUrl = getPlayerRoundImage(room, player.id);
    io.to(player.id).emit("roundData", {
      imageUrl,
      round: room.roundIndex + 1,
      totalRounds: TOTAL_ROUNDS,
      subject: room.subject
    });
  });
}

function getPlayerRoundImage(room, playerId) {
  const assignments = room.playerImageAssignments || {};
  const imageIndex = Number.isInteger(assignments[playerId]) ? assignments[playerId] : 0;
  return room.roundImageUrls?.[imageIndex] || room.roundImageUrls?.[0] || room.currentImageUrl;
}

function finalizeRound(room, { requireAllSubmitted = true, reason = "manual" } = {}) {
  if (room.players.length < 2 || !room.roundActive) {
    return;
  }

  const participants = (room.roundParticipants || []).filter((pid) => room.players.find((p) => p.id === pid));
  if (participants.length < 2) {
    clearRoundTimer(room);
    room.roundActive = false;
    room.roundParticipants = [];
    room.guesses = {};
    room.playerImageAssignments = {};
    emitRoomState(room);
    io.to(room.id).emit("info", { message: "אין מספיק שחקנים לסבב פעיל. המנהל צריך להתחיל סבב חדש." });
    return;
  }

  const submittedIds = participants.filter((pid) => room.guesses[pid]);
  if (requireAllSubmitted && submittedIds.length !== participants.length) {
    return;
  }

  // Group submitted guesses by image assignment and normalized description
  const groups = {};
  for (const pid of submittedIds) {
    const words = room.guesses[pid];
    if (!words) {
      continue;
    }
    const imageUrl = getPlayerRoundImage(room, pid);
    const key = `${imageUrl}::${normalizePair(words[0], words[1])}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pid);
  }

  const matchedGroups = Object.values(groups).filter((group) => group.length >= 2);
  const winnerIds = [...new Set(matchedGroups.flat())];

  clearRoundTimer(room);

  if (winnerIds.length > 0) {
    winnerIds.forEach((pid) => {
      room.scores[pid] = (room.scores[pid] || 0) + 1;
    });
    room.pairPoints += 1;

    const winnerNames = winnerIds.map((pid) => {
      const p = room.players.find((pl) => pl.id === pid);
      return p ? p.name : pid;
    });

    room.roundWinners[room.roundIndex] = winnerNames;
    room.roundActive = false;
    room.roundParticipants = [];
    room.playerImageAssignments = {};
    room.guesses = {};
    room.roundIndex += 1;
    prepareManagerPreview(room, room.roundImageUrls || []);

    emitRoomState(room);
    emitManagerPreview(room);
    io.to(room.id).emit("roundResult", { matched: true, winners: winnerNames });

    if (room.roundIndex >= TOTAL_ROUNDS) {
      emitRound(room);
    }
    return;
  }

  room.roundActive = false;
  room.roundParticipants = [];
  room.playerImageAssignments = {};
  room.guesses = {};
  emitRoomState(room);
  emitManagerPreview(room);
  io.to(room.id).emit("roundResult", { matched: false });

  if (reason === "timeout") {
    io.to(room.id).emit("info", { message: "הזמן לסבב הסתיים. לא ניתן להוסיף ניחושים נוספים." });
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function requireAdmin(req, res, next) {
  const auth = (req.headers.authorization || "").trim();
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "נדרשת התחברות" });
  }
  const token = auth.slice(7);
  const session = adminTokens.get(token);
  if (!session) {
    return res.status(401).json({ error: "הפגישה פגה. אנא התחבר מחדש." });
  }
  req.adminSession = session;
  return next();
}

function requireGlobalAdmin(req, res, next) {
  if (req.adminSession.type !== "global") {
    return res.status(403).json({ error: "נדרשת הרשאת מנהל ראשי" });
  }
  return next();
}

function canAccessRoom(req, res, next) {
  const roomId = (req.params.roomId || "").toUpperCase();
  if (req.adminSession.type === "room" && req.adminSession.roomId !== roomId) {
    return res.status(403).json({ error: "אין הרשאה לחדר זה" });
  }
  return next();
}

// ── Admin API ─────────────────────────────────────────────────────────────────

app.post("/api/admin/login", (req, res) => {
  const { username, password, gameCode } = req.body || {};

  if (gameCode) {
    const roomId = (gameCode || "").toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      return res.status(401).json({ error: "קוד משחק לא תקין" });
    }
    if (
      room.hostName !== (username || "").trim() ||
      room.gamePassword !== (password || "")
    ) {
      return res.status(401).json({ error: "שם המשתמש או הסיסמה שגויים" });
    }
    const token = generateToken();
    adminTokens.set(token, { type: "room", roomId });
    return res.json({ token, type: "room", roomId });
  }

  // Global admin
  if ((username || "").trim() !== ADMIN_USER || (password || "") !== ADMIN_PASS) {
    return res.status(401).json({ error: "שם המשתמש או הסיסמה שגויים" });
  }
  const token = generateToken();
  adminTokens.set(token, { type: "global" });
  return res.json({ token, type: "global" });
});

app.get("/api/admin/rooms", requireAdmin, requireGlobalAdmin, (_req, res) => {
  const data = [...rooms.values()].map((room) => ({
    roomId: room.id,
    hostName: room.hostName,
    players: room.players
      .map((p) => ({ name: p.name, score: room.scores[p.id] || 0 }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "he")),
    playerCount: room.players.length,
    started: room.started,
    roundActive: !!room.roundActive,
    roundEndsAt: room.roundEndsAt || null,
    subject: room.subject || "-",
    round: room.roundIndex,
    totalRounds: TOTAL_ROUNDS,
    pairPoints: room.pairPoints,
    roundWinners: room.roundWinners || {}
  }));
  res.json(data);
});

app.get("/api/admin/room/:roomId", requireAdmin, canAccessRoom, (req, res) => {
  const roomId = (req.params.roomId || "").toUpperCase();
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "חדר לא נמצא" });
  }

  const players = room.players
    .map((p) => ({ id: p.id, name: p.name, score: room.scores[p.id] || 0 }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "he"));

  res.json({
    roomId: room.id,
    hostName: room.hostName,
    subject: room.subject || "-",
    started: room.started,
    roundActive: !!room.roundActive,
    roundEndsAt: room.roundEndsAt || null,
    round: room.roundIndex,
    totalRounds: TOTAL_ROUNDS,
    pairPoints: room.pairPoints,
    players,
    roundWinners: room.roundWinners || {}
  });
});

app.delete("/api/admin/room/:roomId/player/:playerId", requireAdmin, canAccessRoom, (req, res) => {
  const roomId = (req.params.roomId || "").toUpperCase();
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ error: "חדר לא נמצא" });
  }

  const playerId = req.params.playerId;
  const targetSocket = io.sockets.sockets.get(playerId);
  if (targetSocket) {
    targetSocket.emit("kicked", { message: "הוצאת מהמשחק על ידי מנהל המשחק." });
    targetSocket.leave(roomId);
  }

  room.players = room.players.filter((p) => p.id !== playerId);
  delete room.scores[playerId];
  delete room.guesses[playerId];
  delete room.playerImageAssignments[playerId];
  room.roundParticipants = (room.roundParticipants || []).filter((pid) => pid !== playerId);

  if (room.players.length === 0) {
    clearRoundTimer(room);
    rooms.delete(roomId);
    return res.json({ ok: true });
  }

  if (room.roundActive && room.roundParticipants.length < 2) {
    clearRoundTimer(room);
    room.roundActive = false;
    room.roundParticipants = [];
    room.playerImageAssignments = {};
    room.guesses = {};
  }

  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
  }

  emitRoomState(room);
  res.json({ ok: true });
});

app.post("/api/admin/room/:roomId/replace-image", requireAdmin, canAccessRoom, (req, res) => {
  const roomId = (req.params.roomId || "").toUpperCase();
  const room = rooms.get(roomId);
  if (!room || !room.started) {
    return res.status(404).json({ error: "חדר לא נמצא או לא התחיל" });
  }

  clearRoundTimer(room);
  prepareManagerPreview(room, room.roundImageUrls || []);
  room.playerImageAssignments = {};
  room.guesses = {};
  room.roundActive = false;
  room.roundParticipants = [];
  io.to(room.id).emit("info", { message: "התמונה הוחלפה על ידי מנהל. יש להזין תיאור חדש." });
  emitRoomState(room);
  emitManagerPreview(room, req.adminSession.type === "room" ? room.hostId : undefined);
  res.json({ ok: true });
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name, gamePassword }) => {
    let roomId = createRoomId();
    while (rooms.has(roomId)) {
      roomId = createRoomId();
    }

    const hostName = (name || "שחקן 1").trim().slice(0, 24) || "שחקן 1";

    const room = {
      id: roomId,
      hostId: socket.id,
      hostName,
      gamePassword: (gamePassword || "").trim(),
      players: [],
      started: false,
      subject: "",
      images: [],
      unusedImages: [],
      roundImageUrls: [],
      activeImageCount: 1,
      playerImageAssignments: {},
      roundIndex: 0,
      roundActive: false,
      roundDurationSec: DEFAULT_ROUND_DURATION_SEC,
      roundEndsAt: null,
      roundParticipants: [],
      guesses: {},
      scores: {},
      pairPoints: 0,
      roundWinners: {}
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.emit("roomCreated", { roomId, link: `/?room=${roomId}` });
    emitRoomState(room);
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);

    if (!room) {
      socket.emit("joinError", { message: "החדר לא נמצא." });
      return;
    }

    // Already in room — just re-sync
    if (room.players.find((p) => p.id === socket.id)) {
      socket.join(normalizedId);
      socket.data.roomId = normalizedId;
      socket.emit("joinedRoom", { roomId: normalizedId });
      emitRoomState(room);
      if (room.started && room.roundActive) {
        socket.emit("roundData", {
          imageUrl: getPlayerRoundImage(room, socket.id),
          round: room.roundIndex + 1,
          totalRounds: TOTAL_ROUNDS,
          subject: room.subject
        });
      } else if (room.started) {
        socket.emit("info", { message: "המשחק פעיל. ממתינים למנהל שיתחיל את הסבב הבא." });
      }
      return;
    }

    const playerName = (name || "שחקן").trim().slice(0, 24) || "שחקן";
    room.players.push({ id: socket.id, name: playerName });
    room.scores[socket.id] = 0;

    socket.join(normalizedId);
    socket.data.roomId = normalizedId;
    socket.emit("joinedRoom", { roomId: normalizedId });
    emitRoomState(room);

    if (room.started && room.hostId === socket.id) {
      emitManagerPreview(room, socket.id);
    }

    if (room.started && room.roundActive) {
      socket.emit("info", { message: "הצטרפת באמצע המשחק. תוכל להשתתף בסבב הבא." });
    } else if (room.started) {
      socket.emit("info", { message: "הצטרפת באמצע המשחק. ממתינים למנהל שיתחיל את הסבב הבא." });
    }
  });

  socket.on("startGame", async ({ roomId, subject }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("joinError", { message: "רק יוצר החדר יכול להתחיל את המשחק." });
      return;
    }

    if (room.players.length < 2) {
      socket.emit("joinError", { message: "צריך לפחות 2 שחקנים כדי להתחיל." });
      return;
    }

    const subjectText = (subject || "").trim();
    if (!subjectText) {
      socket.emit("joinError", { message: "יש להזין נושא לפני התחלת המשחק." });
      return;
    }

    room.subject = subjectText;
    room.images = await buildImagesForSubject(room.subject);
    refillUnusedImages(room);
    prepareManagerPreview(room);
    room.roundIndex = 0;
    room.roundActive = false;
    clearRoundTimer(room);
    room.roundParticipants = [];
    room.playerImageAssignments = {};
    room.guesses = {};
    room.started = true;
    room.pairPoints = 0;
    room.roundWinners = {};

    room.players.forEach((p) => {
      room.scores[p.id] = 0;
    });

    emitRoomState(room);
    io.to(room.id).emit("info", { message: "המשחק התחיל. המנהל צריך ללחוץ על 'התחל סבב'." });
    emitManagerPreview(room, socket.id);
  });

  socket.on("startRound", ({ roomId, durationSec }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room || !room.started) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("joinError", { message: "רק מנהל המשחק יכול להתחיל סבב." });
      return;
    }

    if (room.roundIndex >= TOTAL_ROUNDS) {
      socket.emit("joinError", { message: "המשחק כבר הסתיים." });
      return;
    }

    if (room.players.length < 2) {
      socket.emit("joinError", { message: "נדרשים לפחות 2 שחקנים כדי להתחיל סבב." });
      return;
    }

    if (room.roundActive) {
      socket.emit("joinError", { message: "הסבב כבר פעיל." });
      return;
    }

    if (durationSec !== undefined) {
      const parsed = Number(durationSec);
      if (!Number.isInteger(parsed) || parsed < MIN_ROUND_DURATION_SEC || parsed > MAX_ROUND_DURATION_SEC) {
        socket.emit("joinError", {
          message: `זמן הסבב חייב להיות בין ${MIN_ROUND_DURATION_SEC} ל-${MAX_ROUND_DURATION_SEC} שניות.`
        });
        return;
      }
      room.roundDurationSec = parsed;
    }

    room.activeImageCount = getActiveImageCount(room.players.length);
    room.roundParticipants = room.players.map((p) => p.id);
    room.playerImageAssignments = assignPlayersToImages(room.roundParticipants, room.activeImageCount);
    room.guesses = {};
    room.roundActive = true;
    scheduleRoundTimer(room);

    emitRoomState(room);
    emitRound(room);
    io.to(room.id).emit("info", {
      message: `הסבב התחיל. הניחושים יינעלו אוטומטית בעוד ${room.roundDurationSec} שניות.`
    });
  });

  socket.on("endRound", ({ roomId }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room || !room.started) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("joinError", { message: "רק מנהל המשחק יכול לסיים סבב." });
      return;
    }

    if (!room.roundActive) {
      socket.emit("joinError", { message: "אין סבב פעיל לסיום." });
      return;
    }

    finalizeRound(room, { requireAllSubmitted: false, reason: "manual" });
    io.to(room.id).emit("info", { message: "המנהל סיים את הסבב ונעל ניחושים נוספים." });
  });

  socket.on("changeSubject", async ({ roomId, subject }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room || !room.started) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("joinError", { message: "רק מנהל המשחק יכול לשנות נושא." });
      return;
    }

    if (room.roundActive) {
      socket.emit("joinError", { message: "לא ניתן לשנות נושא כשסבב פעיל." });
      return;
    }

    const subjectText = (subject || "").trim();
    if (!subjectText) {
      socket.emit("joinError", { message: "נושא לא יכול להיות ריק." });
      return;
    }

    room.subject = subjectText;
    room.images = await buildImagesForSubject(room.subject);
    refillUnusedImages(room);
    prepareManagerPreview(room);
    room.playerImageAssignments = {};

    emitRoomState(room);
    io.to(room.id).emit("info", { message: `הנושא שונה ל: ${room.subject}` });
    emitManagerPreview(room, socket.id);
  });

  socket.on("replaceImage", ({ roomId }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room || !room.started) {
      return;
    }

    if (room.hostId !== socket.id) {
      socket.emit("joinError", { message: "רק יוצר החדר יכול להחליף תמונה." });
      return;
    }

    clearRoundTimer(room);
    prepareManagerPreview(room, room.roundImageUrls || []);
    room.roundActive = false;
    room.roundParticipants = [];
    room.playerImageAssignments = {};
    room.guesses = {};
    io.to(room.id).emit("info", { message: "התמונה הוחלפה. יש להזין תיאור חדש." });
    emitManagerPreview(room, socket.id);
    emitRoomState(room);
  });

  socket.on("submitGuess", ({ roomId, description }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room || !room.started) {
      return;
    }

    if (!room.roundActive) {
      socket.emit("joinError", { message: "הסבב עדיין לא התחיל. המתן למנהל המשחק." });
      return;
    }

    if (!room.players.find((p) => p.id === socket.id)) {
      socket.emit("joinError", { message: "רק שחקנים בחדר יכולים לשלוח תיאור." });
      return;
    }

    if (!room.roundParticipants.includes(socket.id)) {
      socket.emit("joinError", { message: "הצטרפת אחרי תחילת הסבב. תוכל להשתתף בסבב הבא." });
      return;
    }

    const words = parseTwoWordDescription(description);
    if (!words) {
      socket.emit("joinError", { message: "התיאור חייב להכיל בדיוק 2 מילים." });
      return;
    }

    room.guesses[socket.id] = words;
    socket.emit("guessSaved", { ok: true });
    finalizeRound(room, { requireAllSubmitted: true, reason: "all_submitted" });
  });

  socket.on("kickPlayer", ({ roomId, targetId }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room || room.hostId !== socket.id) {
      return;
    }

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.emit("kicked", { message: "הוצאת מהמשחק על ידי מנהל המשחק." });
      targetSocket.leave(normalizedId);
    }

    room.players = room.players.filter((p) => p.id !== targetId);
    delete room.scores[targetId];
    delete room.guesses[targetId];
    delete room.playerImageAssignments[targetId];
    room.roundParticipants = (room.roundParticipants || []).filter((pid) => pid !== targetId);

    if (room.roundActive && room.roundParticipants.length < 2) {
      clearRoundTimer(room);
      room.roundActive = false;
      room.roundParticipants = [];
      room.playerImageAssignments = {};
      room.guesses = {};
      io.to(normalizedId).emit("info", { message: "אין מספיק שחקנים לסבב. המנהל צריך להתחיל סבב חדש." });
    }

    if (room.players.length === 0) {
      clearRoundTimer(room);
      rooms.delete(normalizedId);
      return;
    }

    emitRoomState(room);
    emitManagerPreview(room);
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    room.players = room.players.filter((p) => p.id !== socket.id);
    delete room.scores[socket.id];
    delete room.guesses[socket.id];
    delete room.playerImageAssignments[socket.id];
    room.roundParticipants = (room.roundParticipants || []).filter((pid) => pid !== socket.id);

    if (room.hostId === socket.id) {
      room.hostId = null;
      io.to(roomId).emit("info", { message: "מנהל המשחק התנתק." });
    }

    if (room.players.length === 0 && !room.hostId) {
      clearRoundTimer(room);
      rooms.delete(roomId);
      return;
    }

    if (room.roundActive && room.roundParticipants.length < 2) {
      clearRoundTimer(room);
      room.roundActive = false;
      room.roundParticipants = [];
      room.playerImageAssignments = {};
      room.guesses = {};
      io.to(roomId).emit("info", { message: "אין מספיק שחקנים לסבב. המנהל צריך להתחיל סבב חדש." });
    }

    emitRoomState(room);
    emitManagerPreview(room);
    io.to(roomId).emit("info", { message: "אחד השחקנים התנתק." });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
