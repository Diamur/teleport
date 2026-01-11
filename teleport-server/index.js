"use strict";

const http = require("http");
const WebSocket = require("ws");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// -------------------- HTTP (/health) --------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  // остальное не нужно
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

// -------------------- WS (/ws) --------------------
const wss = new WebSocket.Server({ server, path: "/ws" });

// ws -> { name }
const infoByWs = new Map();
// name -> ws
const wsByName = new Map();

function safeName(v) {
  if (typeof v !== "string") return "";
  const s = v.trim().slice(0, 32);
  return s.replace(/[^\p{L}\p{N}_\.\-]/gu, "");
}

function send(ws, obj) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(obj, exceptWs = null) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN && ws !== exceptWs) {
      ws.send(msg);
    }
  }
}

function removeClient(ws) {
  const info = infoByWs.get(ws);
  if (info && info.name) {
    const cur = wsByName.get(info.name);
    if (cur === ws) wsByName.delete(info.name);
    broadcast({ type: "sys", text: `${info.name} вышел` }, ws);
  }
  infoByWs.delete(ws);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    // JOIN
    if (data.type === "join") {
      const name = safeName(data.name);
      if (!name) {
        send(ws, { type: "err", error: "bad_name" });
        return;
      }

      // если имя занято — выкидываем старое соединение
      const old = wsByName.get(name);
      if (old && old !== ws) {
        try {
          send(old, { type: "sys", text: "Вы вошли с другого устройства" });
          old.close();
        } catch {}
        removeClient(old);
      }

      infoByWs.set(ws, { name });
      wsByName.set(name, ws);

      send(ws, { type: "joined", name });
      broadcast({ type: "sys", text: `${name} в сети` }, ws);
      return;
    }

    // дальше — только для тех, кто joined
    const info = infoByWs.get(ws);
    if (!info || !info.name) {
      send(ws, { type: "err", error: "not_joined" });
      return;
    }

    // WHO (кто онлайн) — полезно для клиента /client
    if (data.type === "who") {
      const users = Array.from(wsByName.keys()).sort((a, b) => a.localeCompare(b, "ru"));
      send(ws, {
        type: "who",
        you: info.name,
        users,
      });
      return;
    }

    // CHAT (опционально)
    if (data.type === "chat") {
      const text = typeof data.text === "string" ? data.text.slice(0, 2000) : "";
      broadcast({ type: "chat", from: info.name, text }, null);
      return;
    }

    // WEBRTC signaling
    if (data.type === "webrtc") {
      const p = data.payload || {};
      const to = safeName(p.to);
      const from = safeName(p.from) || info.name;

      if (!to) {
        // если "to" нет — шлём всем (на всякий)
        broadcast({ type: "webrtc", payload: { ...p, from } }, ws);
        return;
      }

      const dest = wsByName.get(to);
      if (!dest || dest.readyState !== WebSocket.OPEN) {
        send(ws, { type: "err", error: "user_offline", to });
        return;
      }

      send(dest, { type: "webrtc", payload: { ...p, from, to } });
      return;
    }
  });

  ws.on("close", () => removeClient(ws));
  ws.on("error", () => removeClient(ws));

  send(ws, { type: "sys", text: "Подключились. Жду join…" });
});

// keepalive ping
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch {}
      removeClient(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);

server.listen(PORT, HOST, () => {
  console.log(`HTTP health:  http://${HOST}:${PORT}/health`);
  console.log(`WS signaling: ws://${HOST}:${PORT}/ws`);
});
