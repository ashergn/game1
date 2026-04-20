const socket = io();

const lobbyCard = document.getElementById("lobbyCard");
const gameCard = document.getElementById("gameCard");
const nameInput = document.getElementById("nameInput");
const createRoomBtn = document.getElementById("createRoomBtn");
const roomCodeInput = document.getElementById("roomCodeInput");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const shareArea = document.getElementById("shareArea");
const shareLinkInput = document.getElementById("shareLink");
const copyBtn = document.getElementById("copyBtn");
const statusText = document.getElementById("statusText");

const roomLabel = document.getElementById("roomLabel");
const roundLabel = document.getElementById("roundLabel");
const scorePill = document.getElementById("scorePill");
const replaceImageBtn = document.getElementById("replaceImageBtn");
const subjectArea = document.getElementById("subjectArea");
const subjectInput = document.getElementById("subjectInput");
const startBtn = document.getElementById("startBtn");
const imageWrap = document.getElementById("imageWrap");
const gameImage = document.getElementById("gameImage");
const guessForm = document.getElementById("guessForm");
const descriptionInput = document.getElementById("descriptionInput");
const resultBox = document.getElementById("resultBox");
const playersList = document.getElementById("playersList");

let currentRoomId = "";
let meName = "";

function getName() {
  return (nameInput.value || "").trim().slice(0, 24) || "שחקן";
}

function setStatus(text) {
  statusText.textContent = text;
}

function switchToGame() {
  lobbyCard.classList.add("hidden");
  gameCard.classList.remove("hidden");
}

function getRoomFromUrl() {
  const url = new URL(window.location.href);
  return (url.searchParams.get("room") || "").toUpperCase();
}

function setRoomInUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  window.history.replaceState({}, "", url.toString());
}

createRoomBtn.addEventListener("click", () => {
  meName = getName();
  socket.emit("createRoom", { name: meName });
});

joinRoomBtn.addEventListener("click", () => {
  meName = getName();
  const roomId = (roomCodeInput.value || "").trim().toUpperCase() || getRoomFromUrl();
  if (!roomId) {
    setStatus("יש להזין קוד חדר.");
    return;
  }
  socket.emit("joinRoom", { roomId, name: meName });
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(shareLinkInput.value);
  copyBtn.textContent = "הועתק";
  setTimeout(() => {
    copyBtn.textContent = "העתק";
  }, 1500);
});

startBtn.addEventListener("click", () => {
  const subject = (subjectInput.value || "").trim();
  if (!subject) {
    resultBox.textContent = "יש להזין נושא לפני התחלת המשחק.";
    return;
  }

  socket.emit("startGame", { roomId: currentRoomId, subject });
});

replaceImageBtn.addEventListener("click", () => {
  socket.emit("replaceImage", { roomId: currentRoomId });
});

guessForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const description = descriptionInput.value.trim().toLowerCase().replace(/\s+/g, " ");
  const words = description ? description.split(" ") : [];
  if (words.length !== 2) {
    resultBox.textContent = "התיאור חייב להכיל בדיוק 2 מילים.";
    return;
  }

  socket.emit("submitGuess", { roomId: currentRoomId, description });
  resultBox.textContent = "נשמר. ממתין לשותף...";
});

socket.on("roomCreated", ({ roomId, link }) => {
  currentRoomId = roomId;
  setRoomInUrl(roomId);
  roomCodeInput.value = roomId;
  const absolute = `${window.location.origin}${link}`;
  shareLinkInput.value = absolute;
  shareArea.classList.remove("hidden");
  setStatus(`החדר ${roomId} נוצר. שתפו את הקישור והמתינו לשחקן 2.`);
  switchToGame();
});

socket.on("joinedRoom", ({ roomId }) => {
  currentRoomId = roomId;
  setRoomInUrl(roomId);
  roomCodeInput.value = roomId;
  setStatus(`הצטרפת לחדר ${roomId}.`);
  switchToGame();
});

socket.on("roomState", (room) => {
  currentRoomId = room.roomId;

  roomLabel.textContent = `חדר ${room.roomId}`;
  roundLabel.textContent = room.started
    ? `נושא: ${room.subject || "-"}`
    : `שחקנים: ${room.playerCount}/2`;
  scorePill.textContent = `נקודות זוג: ${room.pairPoints || 0}`;

  const amHost = room.hostId === socket.id;
  subjectArea.classList.toggle("hidden", room.started || !amHost || room.playerCount < 2);
  replaceImageBtn.classList.toggle("hidden", !room.started || !amHost);

  playersList.innerHTML = "";
  room.scores.forEach((p) => {
    const tag = document.createElement("div");
    tag.className = "player-tag";
    tag.textContent = `${p.name}: ${p.points}`;
    playersList.appendChild(tag);
  });

  if (!room.started && room.playerCount < 2) {
    resultBox.textContent = "ממתין לשחקן השני שיצטרף.";
  }
});

socket.on("roundData", ({ imageUrl, round, total, subject }) => {
  imageWrap.classList.remove("hidden");
  guessForm.classList.remove("hidden");
  subjectArea.classList.add("hidden");

  gameImage.src = imageUrl;
  roundLabel.textContent = `נושא: ${subject} | סבב ${round}/${total}`;
  resultBox.textContent = "כתבו שתי מילים שסביר שגם השותף יבחר.";

  descriptionInput.value = "";
  descriptionInput.focus();
});

socket.on("guessSaved", () => {
  resultBox.textContent = "התיאור נשמר. ממתין לשותף...";
});

socket.on("roundResult", ({ matched }) => {
  if (matched) {
    resultBox.innerHTML = "<strong>יש התאמה!</strong> שני השחקנים בחרו אותו תיאור בן 2 מילים.";
  } else {
    resultBox.innerHTML = "<strong>עדיין אין התאמה.</strong> נסו שוב על אותה התמונה.";
  }
});

socket.on("gameOver", ({ scores, pairPoints, totalRounds }) => {
  guessForm.classList.add("hidden");
  resultBox.innerHTML = `<strong>המשחק הסתיים.</strong> נקודות זוג: ${pairPoints}/${totalRounds}<br>${scores
    .map((s) => `${s.name}: ${s.points}`)
    .join("<br>")}`;
});

socket.on("joinError", ({ message }) => {
  resultBox.textContent = message;
  setStatus(message);
});

window.addEventListener("load", () => {
  const presetRoom = getRoomFromUrl();
  if (presetRoom) {
    roomCodeInput.value = presetRoom;
    setStatus(`זוהה חדר ${presetRoom}. הזן שם ולחץ על "הצטרף".`);
  }
});
