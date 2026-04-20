const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const scoreboard = new Map();
const TARGET_IMAGE_POOL_SIZE = 120;
const FALLBACK_IMAGE_POOL_SIZE = 180;
const WIKIMEDIA_PAGE_LIMIT = 50;
const WIKIMEDIA_MAX_PAGES = 8;

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

  let nextIndex = room.unusedImages.findIndex((url) => url && url !== avoidUrl);
  if (nextIndex === -1) {
    refillUnusedImages(room);
    nextIndex = room.unusedImages.findIndex((url) => url && url !== avoidUrl);
  }

  if (nextIndex !== -1) {
    const [picked] = room.unusedImages.splice(nextIndex, 1);
    return picked;
  }

  return buildFallbackImages(room.subject || "random")[0];
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
    totalRounds: 5,
    pairPoints: room.pairPoints,
    scores: room.players.map((p) => ({ name: p.name, points: room.scores[p.id] || 0 }))
  };
}

function updateScoreboard(room) {
  scoreboard.set(room.id, {
    roomId: room.id,
    subject: room.subject || "-",
    players: room.players.map((p) => p.name),
    pairPoints: room.pairPoints,
    roundsCompleted: room.roundIndex,
    totalRounds: 5,
    lastUpdated: new Date().toISOString()
  });
}

function emitRoomState(room) {
  io.to(room.id).emit("roomState", getPublicRoomState(room));
  updateScoreboard(room);
}

function emitRound(room) {
  if (room.roundIndex >= 5) {
    io.to(room.id).emit("gameOver", {
      scores: room.players.map((p) => ({ name: p.name, points: room.scores[p.id] || 0 })),
      pairPoints: room.pairPoints,
      totalRounds: 5
    });
    return;
  }

  io.to(room.id).emit("roundData", {
    imageUrl: room.currentImageUrl,
    round: room.roundIndex + 1,
    totalRounds: 5,
    subject: room.subject
  });
}

function handleGuess(room) {
  if (room.players.length < 2) {
    return;
  }

  const [playerA, playerB] = room.players;
  const guessA = room.guesses[playerA.id];
  const guessB = room.guesses[playerB.id];
  if (!guessA || !guessB) {
    return;
  }

  const same = normalizePair(guessA[0], guessA[1]) === normalizePair(guessB[0], guessB[1]);

  io.to(room.id).emit("roundResult", {
    matched: same
  });

  room.guesses = {};

  if (same) {
    room.scores[playerA.id] = (room.scores[playerA.id] || 0) + 1;
    room.scores[playerB.id] = (room.scores[playerB.id] || 0) + 1;
    room.pairPoints += 1;
    room.roundIndex += 1;
    room.currentImageUrl = pickRandomImage(room, room.currentImageUrl);
    emitRoomState(room);

    setTimeout(() => {
      const refreshed = rooms.get(room.id);
      if (refreshed) {
        emitRound(refreshed);
      }
    }, 1800);
  }
}

function adminAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Authentication required");
  }

  const base64 = authHeader.slice("Basic ".length).trim();
  let decoded = "";
  try {
    decoded = Buffer.from(base64, "base64").toString("utf8");
  } catch (_error) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Invalid authentication");
  }

  const splitIndex = decoded.indexOf(":");
  const user = splitIndex >= 0 ? decoded.slice(0, splitIndex) : "";
  const pass = splitIndex >= 0 ? decoded.slice(splitIndex + 1) : "";

  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Panel"');
    return res.status(401).send("Invalid credentials");
  }

  return next();
}

app.get("/api/scoreboard", adminAuth, (_req, res) => {
  const rows = [...scoreboard.values()]
    .sort((a, b) => b.pairPoints - a.pairPoints)
    .map((item) => ({
      ...item,
      players: item.players.join(" & ")
    }));
  res.json(rows);
});

app.get("/api/rooms", adminAuth, (_req, res) => {
  const data = [...rooms.values()].map((room) => ({
    roomId: room.id,
    players: room.players.map((p) => p.name),
    playerCount: room.players.length,
    started: room.started,
    subject: room.subject || "-",
    round: room.roundIndex,
    totalRounds: 5,
    pairPoints: room.pairPoints
  }));
  res.json(data);
});

app.get("/admin", adminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }) => {
    let roomId = createRoomId();
    while (rooms.has(roomId)) {
      roomId = createRoomId();
    }

    const room = {
      id: roomId,
      hostId: socket.id,
      players: [{ id: socket.id, name: (name || "שחקן 1").trim().slice(0, 24) || "שחקן 1" }],
      started: false,
      subject: "",
      images: [],
      unusedImages: [],
      roundIndex: 0,
      guesses: {},
      scores: { [socket.id]: 0 },
      pairPoints: 0
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

    if (room.players.length >= 2 && !room.players.find((p) => p.id === socket.id)) {
      socket.emit("joinError", { message: "בחדר כבר יש 2 שחקנים." });
      return;
    }

    if (!room.players.find((p) => p.id === socket.id)) {
      room.players.push({ id: socket.id, name: (name || "שחקן 2").trim().slice(0, 24) || "שחקן 2" });
      room.scores[socket.id] = room.scores[socket.id] || 0;
    }

    socket.join(normalizedId);
    socket.data.roomId = normalizedId;

    socket.emit("joinedRoom", { roomId: normalizedId });
    emitRoomState(room);

    if (room.started) {
      emitRound(room);
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
      socket.emit("joinError", { message: "צריך 2 שחקנים כדי להתחיל." });
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
    room.currentImageUrl = pickRandomImage(room);
    room.roundIndex = 0;
    room.guesses = {};
    room.started = true;
    room.pairPoints = 0;

    room.players.forEach((p) => {
      room.scores[p.id] = 0;
    });

    emitRoomState(room);
    emitRound(room);
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

    room.currentImageUrl = pickRandomImage(room, room.currentImageUrl);
    room.guesses = {};
    io.to(room.id).emit("joinError", { message: "התמונה הוחלפה. יש להזין תיאור חדש." });
    emitRound(room);
  });

  socket.on("submitGuess", ({ roomId, description }) => {
    const normalizedId = (roomId || "").toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room || !room.started) {
      return;
    }

    const words = parseTwoWordDescription(description);
    if (!words) {
      socket.emit("joinError", { message: "התיאור חייב להכיל בדיוק 2 מילים." });
      return;
    }

    room.guesses[socket.id] = words;
    socket.emit("guessSaved", { ok: true });
    handleGuess(room);
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

    if (room.players.length === 0) {
      rooms.delete(roomId);
      scoreboard.delete(roomId);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
    }

    emitRoomState(room);
    io.to(roomId).emit("joinError", { message: "אחד השחקנים התנתק." });
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
