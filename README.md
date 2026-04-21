# תיבת נח 2026 (2-Player Realtime Game)

A web-based game where:

1. Player 1 creates a room and shares a unique link.
2. Player 2 joins the same room.
3. Host selects a subject (`dogs`, `cats`, `usa`, or any custom subject).
4. Both players see the same image and each choose 2 words.
5. If both descriptions match (order does not matter), they win the round and move to the next image.
6. Management dashboard tracks each couple's points.

## Routes

- `/` -> Game UI
- `/admin` -> Management dashboard
- `/api/scoreboard` -> JSON score data

## Admin protection

The admin panel is protected with HTTP Basic Auth.

- Username env var: `ADMIN_USER`
- Password env var: `ADMIN_PASS`

Defaults (change in production):

- `ADMIN_USER=admin`
- `ADMIN_PASS=change-me`

Example local run in PowerShell:

```powershell
$env:ADMIN_USER="myadmin"
$env:ADMIN_PASS="StrongPassword123"
npm start
```

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy to cloud (Render)

1. Push this project to GitHub.
2. Go to Render and create a **Web Service** from your repo.
3. Render will detect `render.yaml` automatically.
4. Deploy.
5. Your app will get a public URL like:
   `https://teivat-noah-2026.onrender.com`
6. In Render service settings, add environment variables:
   - `ADMIN_USER`
   - `ADMIN_PASS`

## Deploy to cloud (Railway)

1. Push this project to GitHub.
2. Create a new Railway project from that repo.
3. Railway uses `npm install` and `npm start` automatically.
4. Deploy and get your public URL.
