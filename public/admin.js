const rowsBody = document.getElementById("scoreRows");
const roomRowsBody = document.getElementById("roomRows");

async function refreshScores() {
  const [scoreRes, roomRes] = await Promise.all([fetch("/api/scoreboard"), fetch("/api/rooms")]);
  const data = await scoreRes.json();
  const rooms = await roomRes.json();

  rowsBody.innerHTML = "";

  if (!data.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="6">עדיין אין משחקים פעילים או משחקים שהסתיימו.</td>';
    rowsBody.appendChild(row);
  } else {
    data.forEach((item) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${item.roomId}</td>
        <td>${item.players}</td>
        <td>${item.subject}</td>
        <td>${item.pairPoints}</td>
        <td>${item.roundsCompleted}/${item.totalRounds}</td>
        <td>${new Date(item.lastUpdated).toLocaleTimeString()}</td>
      `;
      rowsBody.appendChild(tr);
    });
  }

  roomRowsBody.innerHTML = "";
  if (!rooms.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="7">כרגע אין חדרים פעילים.</td>';
    roomRowsBody.appendChild(row);
    return;
  }

  rooms.forEach((room) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${room.roomId}</td>
      <td>${room.players.join(" & ") || "-"}</td>
      <td>${room.playerCount}</td>
      <td>${room.started ? "במשחק" : "ממתין"}</td>
      <td>${room.subject}</td>
      <td>${room.round}/${room.totalRounds}</td>
      <td>${room.pairPoints}</td>
    `;
    roomRowsBody.appendChild(tr);
  });
}

refreshScores();
setInterval(refreshScores, 2000);
