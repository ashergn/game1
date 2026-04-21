let authToken = null;
let adminType = null;
let adminRoomId = null;
let refreshInterval = null;

const loginSection = document.getElementById("loginSection");
const globalView = document.getElementById("globalView");
const roomView = document.getElementById("roomView");
const roomCountdown = document.getElementById("roomCountdown");

function getCountdownLabel(roundActive, roundEndsAt) {
  if (!roundActive || !roundEndsAt) {
    return "-";
  }

  const msLeft = Number(roundEndsAt) - Date.now();
  const totalSec = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const seconds = String(totalSec % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// ── Login ─────────────────────────────────────────────────────────────────────

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("loginUser").value.trim();
  const password = document.getElementById("loginPass").value;
  const gameCode = document.getElementById("loginGame").value.trim().toUpperCase();
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, gameCode: gameCode || undefined })
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || "שגיאה בהתחברות";
      return;
    }

    authToken = data.token;
    adminType = data.type;
    adminRoomId = data.roomId || null;

    loginSection.classList.add("hidden");

    if (adminType === "global") {
      globalView.classList.remove("hidden");
      startGlobalRefresh();
    } else {
      document.getElementById("roomViewId").textContent = adminRoomId;
      roomView.classList.remove("hidden");
      startRoomRefresh();
    }
  } catch (_err) {
    errorEl.textContent = "שגיאת חיבור לשרת";
  }
});

function authHeaders() {
  return { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" };
}

function logout() {
  authToken = null;
  adminType = null;
  adminRoomId = null;
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = null;
  globalView.classList.add("hidden");
  roomView.classList.add("hidden");
  loginSection.classList.remove("hidden");
}

document.getElementById("logoutGlobal").addEventListener("click", logout);
document.getElementById("logoutRoom").addEventListener("click", logout);

// ── Global admin ──────────────────────────────────────────────────────────────

async function refreshAllGames() {
  try {
    const res = await fetch("/api/admin/rooms", { headers: authHeaders() });
    if (res.status === 401) {
      logout();
      return;
    }
    const rooms = await res.json();
    const tbody = document.getElementById("allGamesBody");
    tbody.innerHTML = "";

    if (!rooms.length) {
      tbody.innerHTML = '<tr><td colspan="8">אין משחקים פעילים כרגע.</td></tr>';
      return;
    }

    rooms.forEach((room) => {
      const tr = document.createElement("tr");
      const playerNames = room.players.map((p) => `${p.name} (${p.score})`).join(", ");
      tr.innerHTML = `
        <td>${room.roomId}</td>
        <td>${room.hostName}</td>
        <td>${playerNames || "-"}</td>
        <td>${room.subject}</td>
        <td>${room.started ? "במשחק" : "ממתין"}</td>
        <td>${getCountdownLabel(room.roundActive, room.roundEndsAt)}</td>
        <td>${room.round}/${room.totalRounds}</td>
        <td>${room.pairPoints}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (_) {}
}

function startGlobalRefresh() {
  refreshAllGames();
  refreshInterval = setInterval(refreshAllGames, 3000);
}

// ── Room admin ────────────────────────────────────────────────────────────────

async function refreshRoom() {
  try {
    const res = await fetch(`/api/admin/room/${adminRoomId}`, { headers: authHeaders() });
    if (res.status === 401) {
      logout();
      return;
    }
    if (!res.ok) return;

    const room = await res.json();

    document.getElementById("roomViewSubtitle").textContent =
      `נושא: ${room.subject} | סבב ${room.round}/${room.totalRounds} | נקודות זוג: ${room.pairPoints}`;
    roomCountdown.textContent = room.roundActive
      ? `נעילה אוטומטית בעוד: ${getCountdownLabel(room.roundActive, room.roundEndsAt)}`
      : "אין סבב פעיל כרגע.";

    // Winners
    const winnersBox = document.getElementById("roomWinnersBox");
    const winnersList = document.getElementById("roomWinnersList");
    const entries = Object.entries(room.roundWinners || {});
    if (entries.length) {
      winnersBox.style.display = "block";
      winnersList.innerHTML = entries
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([r, names]) => `<div>סבב ${Number(r) + 1}: <strong>${names.join(", ")}</strong></div>`)
        .join("");
    } else {
      winnersBox.style.display = "none";
    }

    // Replace image button
    document.getElementById("replaceImageAdminBtn").style.display = room.started ? "" : "none";

    // Players table
    const tbody = document.getElementById("playersBody");
    tbody.innerHTML = "";
    room.players.forEach((player, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${player.name}</td>
        <td>${player.score}</td>
        <td>
          <button
            class="kick-btn secondary"
            data-id="${player.id}"
            data-name="${player.name}"
            title="הוצא שחקן"
            style="padding:4px 10px;min-height:30px;font-size:16px"
          >🗑️</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll(".kick-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const playerId = btn.dataset.id;
        const playerName = btn.dataset.name;
        if (!confirm(`להוציא את ${playerName} מהמשחק?`)) return;
        await fetch(`/api/admin/room/${adminRoomId}/player/${playerId}`, {
          method: "DELETE",
          headers: authHeaders()
        });
        refreshRoom();
      });
    });
  } catch (_) {}
}

function startRoomRefresh() {
  refreshRoom();
  refreshInterval = setInterval(refreshRoom, 2000);
}

document.getElementById("replaceImageAdminBtn").addEventListener("click", async () => {
  await fetch(`/api/admin/room/${adminRoomId}/replace-image`, {
    method: "POST",
    headers: authHeaders()
  });
  refreshRoom();
});

