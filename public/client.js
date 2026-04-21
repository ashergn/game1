const socket = io();

const lobbyCard = document.getElementById("lobbyCard");
const gameCard = document.getElementById("gameCard");
const nameInput = document.getElementById("nameInput");
const createRoomBtn = document.getElementById("createRoomBtn");
const createPassInput = document.getElementById("createPassInput");
const roomCodeInput = document.getElementById("roomCodeInput");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const shareArea = document.getElementById("shareArea");
const shareLinkInput = document.getElementById("shareLink");
const copyBtn = document.getElementById("copyBtn");
const statusText = document.getElementById("statusText");

const roomLabel = document.getElementById("roomLabel");
const roundLabel = document.getElementById("roundLabel");
const scorePill = document.getElementById("scorePill");
const startRoundBtn = document.getElementById("startRoundBtn");
const roundCountdown = document.getElementById("roundCountdown");
const replaceImageBtn = document.getElementById("replaceImageBtn");
const subjectArea = document.getElementById("subjectArea");
const subjectInput = document.getElementById("subjectInput");
const startBtn = document.getElementById("startBtn");
const imageWrap = document.getElementById("imageWrap");
const gameImage = document.getElementById("gameImage");
const guessForm = document.getElementById("guessForm");
const descriptionInput = document.getElementById("descriptionInput");
const guessSubmitBtn = guessForm.querySelector('button[type="submit"]');
const resultBox = document.getElementById("resultBox");
const playersList = document.getElementById("playersList");
const managerPreview = document.getElementById("managerPreview");
const changeSubjectInput = document.getElementById("changeSubjectInput");
const changeSubjectBtn = document.getElementById("changeSubjectBtn");
const roundDurationInput = document.getElementById("roundDurationInput");
const managerPreviewHint = document.getElementById("managerPreviewHint");
const managerPreviewCounts = document.getElementById("managerPreviewCounts");
const managerImageA = document.getElementById("managerImageA");
const managerImageB = document.getElementById("managerImageB");
const managerImageC = document.getElementById("managerImageC");

let currentRoomId = "";
let meName = "";
let currentRoomState = null;
let countdownInterval = null;
let guessSubmittedThisRound = false;

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clearCountdownInterval() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function formatCountdown(msLeft) {
  const totalSec = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const seconds = String(totalSec % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateManagerCountdown(room, amHost) {
  if (!amHost || !room.roundActive || !room.roundEndsAt) {
    roundCountdown.classList.add("hidden");
    roundCountdown.textContent = "נותרו 00:00";
    clearCountdownInterval();
    return;
  }

  const render = () => {
    const msLeft = Number(room.roundEndsAt) - Date.now();
    roundCountdown.classList.remove("hidden");
    roundCountdown.textContent = `נותרו ${formatCountdown(msLeft)}`;
  };

  render();
  clearCountdownInterval();
  countdownInterval = setInterval(render, 1000);
}

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
  const gamePassword = (createPassInput.value || "").trim();
  socket.emit("createRoom", { name: meName, gamePassword });
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

startRoundBtn.addEventListener("click", () => {
  if (!currentRoomState) {
    return;
  }

  if (currentRoomState.roundActive) {
    socket.emit("endRound", { roomId: currentRoomId });
    return;
  }

  const durationSec = Number.parseInt(roundDurationInput.value, 10);
  socket.emit("startRound", { roomId: currentRoomId, durationSec });
});

changeSubjectBtn.addEventListener("click", () => {
  const newSubject = (changeSubjectInput.value || "").trim();
  if (!newSubject) {
    resultBox.textContent = "אנא הזן נושא חדש.";
    return;
  }
  socket.emit("changeSubject", { roomId: currentRoomId, subject: newSubject });
  changeSubjectInput.value = "";
});

guessForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (guessSubmittedThisRound) {
    return;
  }

  const description = descriptionInput.value.trim().toLowerCase().replace(/\s+/g, " ");
  const words = description ? description.split(" ") : [];
  if (words.length !== 2) {
    resultBox.textContent = "התיאור חייב להכיל בדיוק 2 מילים.";
    return;
  }

  socket.emit("submitGuess", { roomId: currentRoomId, description });
  guessSubmittedThisRound = true;
  guessSubmitBtn.textContent = "נשלח";
  guessSubmitBtn.disabled = true;
  descriptionInput.disabled = true;
  resultBox.textContent = "נשמר. ממתין לשחקנים אחרים...";
});

socket.on("roomCreated", ({ roomId, link }) => {
  currentRoomId = roomId;
  setRoomInUrl(roomId);
  roomCodeInput.value = roomId;
  const absolute = `${window.location.origin}${link}`;
  shareLinkInput.value = absolute;
  shareArea.classList.remove("hidden");
  setStatus(`החדר ${roomId} נוצר. אתה מנהל המשחק, לא שחקן. אם תרצה לשחק פתח לשונית נוספת והצטרף כשחקן.`);
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
  currentRoomState = room;

  roomLabel.textContent = `חדר ${room.roomId}`;
  roundLabel.textContent = room.started
    ? `נושא: ${room.subject || "-"}`
    : `שחקנים: ${room.playerCount}`;
  scorePill.textContent = `נקודות: ${room.pairPoints || 0}`;

  const amHost = room.hostId === socket.id;
  subjectArea.classList.toggle("hidden", room.started || !amHost || room.playerCount < 2);
  managerPreview.classList.toggle("hidden", !room.started || !amHost);
  startRoundBtn.classList.toggle("hidden", !room.started || !amHost || room.roundIndex >= room.totalRounds);
  startRoundBtn.textContent = room.roundActive ? "סיים סבב" : "התחל סבב";
  replaceImageBtn.classList.toggle("hidden", !room.started || !amHost);
  imageWrap.classList.toggle("hidden", !room.roundActive || amHost);
  guessForm.classList.toggle("hidden", !room.started || !room.roundActive || amHost);
  roundDurationInput.disabled = !!room.roundActive;
  if (document.activeElement !== roundDurationInput) {
    roundDurationInput.value = String(room.roundDurationSec || 60);
  }
  updateManagerCountdown(room, amHost);

  playersList.innerHTML = "";
  (room.scores || []).forEach((p) => {
    const tag = document.createElement("div");
    tag.className = "player-tag";
    const isMe = p.id === socket.id;
    tag.textContent = `${p.name}${isMe ? " (אני)" : ""}: ${p.points}`;
    if (isMe) tag.style.background = "#0f766e22";
    playersList.appendChild(tag);
  });

  if (!room.started && room.playerCount < 2) {
    resultBox.textContent = "ממתין לשחקנים נוספים שיצטרפו.";
  }

  if (!room.hostId) {
    resultBox.textContent = "מנהל המשחק התנתק. לא ניתן להתחיל או להחליף תמונה כרגע.";
  }

  if (room.started && !room.roundActive) {
    if (amHost && room.roundIndex < room.totalRounds) {
      resultBox.textContent = "הסבב ממתין. לחץ על 'התחל סבב'.";
    }
    if (!amHost && room.roundIndex < room.totalRounds) {
      resultBox.textContent = "ממתינים למנהל המשחק שיתחיל את הסבב.";
    }
  }
  if (room.started && room.roundActive && amHost) {
    resultBox.textContent = "הסבב פעיל. ניתן ללחוץ על 'סיים סבב' כדי לנעול ניחושים מיידית.";
  }
});

socket.on("roundData", ({ imageUrl, round, totalRounds, subject }) => {
  imageWrap.classList.remove("hidden");
  guessForm.classList.remove("hidden");
  subjectArea.classList.add("hidden");
  guessSubmittedThisRound = false;
  guessSubmitBtn.textContent = "שלח תיאור";
  guessSubmitBtn.disabled = false;
  descriptionInput.disabled = false;

  gameImage.src = imageUrl;
  roundLabel.textContent = `נושא: ${subject} | סבב ${round}/${totalRounds}`;
  resultBox.textContent = "כתבו שתי מילים שסביר שגם שחקנים אחרים יבחרו.";

  descriptionInput.value = "";
  descriptionInput.focus();
});

socket.on("guessSaved", () => {
  resultBox.textContent = "התיאור נשמר. ממתין לשחקנים אחרים...";
  guessSubmittedThisRound = true;
  guessSubmitBtn.textContent = "נשלח";
  guessSubmitBtn.disabled = true;
  descriptionInput.disabled = true;
});

socket.on("roundResult", ({ matched, winners }) => {
  guessSubmitBtn.disabled = true;
  descriptionInput.disabled = true;
  if (matched) {
    const names = (winners || []).join(", ");
    resultBox.innerHTML = `<strong>יש התאמה!</strong> המנצחים: ${names}`;
  } else {
    resultBox.innerHTML = "<strong>הסבב הסתיים ללא התאמה.</strong> התחילו סבב חדש.";
  }
});

socket.on("roundTitles", ({ imageLabel, titles }) => {
  const rows = Array.isArray(titles) ? titles : [];
  const content = rows.length
    ? rows
      .map((item) => `${escapeHtml(item.playerName)}: ${escapeHtml(item.description)}`)
      .join("<br>")
    : "לא נשלחו תיאורים לתמונה הזו בסבב.";

  resultBox.innerHTML += `
    <div style="margin-top:10px;padding-top:10px;border-top:1px dashed #1f2a2e44">
      <strong>הכותרות לתמונה שלך (תמונה ${escapeHtml(imageLabel)}):</strong><br>
      ${content}
    </div>
  `;
});

socket.on("gameOver", ({ scores, pairPoints, totalRounds }) => {
  guessSubmitBtn.disabled = true;
  descriptionInput.disabled = true;
  guessForm.classList.add("hidden");
  const scoreLines = (scores || [])
    .map((s, i) => `${i + 1}. ${s.name}: ${s.points}`)
    .join("<br>");
  resultBox.innerHTML = `<strong>המשחק הסתיים!</strong> נקודות זוג: ${pairPoints}/${totalRounds}<br><br>${scoreLines}`;
});

socket.on("info", ({ message }) => {
  resultBox.textContent = message;
});

socket.on("showManagerImages", ({ imageUrls, activeImageCount, playerCount, distributionCounts }) => {
  const previews = Array.isArray(imageUrls) ? imageUrls : [];
  const counts = Array.isArray(distributionCounts) ? distributionCounts : [playerCount || 0, 0, 0];
  managerImageA.src = previews[0] || "";
  managerImageB.src = previews[1] || previews[0] || "";
  managerImageC.src = previews[2] || previews[0] || "";
  managerPreviewCounts.innerHTML = `
    <span>תמונה א: ${counts[0] || 0} שחקנים</span>
    <span>תמונה ב: ${activeImageCount > 1 ? counts[1] || 0 : 0} שחקנים</span>
    <span>תמונה ג: ${activeImageCount > 2 ? counts[2] || 0 : 0} שחקנים</span>
  `;

  if (activeImageCount > 2) {
    managerPreviewHint.textContent = `יש ${playerCount} שחקנים, לכן הם יחולקו בין שלוש התמונות בצורה מאוזנת.`;
  } else if (activeImageCount > 1) {
    managerPreviewHint.textContent = `יש ${playerCount} שחקנים, לכן הם יחולקו בין שתי התמונות בצורה מאוזנת.`;
  } else {
    managerPreviewHint.textContent = "יש פחות מ-4 שחקנים, לכן כולם יקבלו את תמונה א כדי להשאיר סיכוי אמיתי להתאמה.";
  }
});

socket.on("kicked", ({ message }) => {
  clearCountdownInterval();
  guessSubmitBtn.disabled = true;
  descriptionInput.disabled = true;
  guessForm.classList.add("hidden");
  imageWrap.classList.add("hidden");
  resultBox.innerHTML = `<strong style="color:#dc2626">${message}</strong>`;
  gameCard.classList.add("hidden");
  lobbyCard.classList.remove("hidden");
  setStatus(message);
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

window.addEventListener("beforeunload", () => {
  clearCountdownInterval();
});


