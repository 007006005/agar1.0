const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3322);
const WIDTH = 12000;
const HEIGHT = 12000;
const HALF_W = WIDTH / 2;
const HALF_H = HEIGHT / 2;
const TICK_MS = 50;

let nextId = 1;
const clients = new Set();
const cells = new Map();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
};

function randomColor() {
  return [
    Math.floor(rand(50, 240)),
    Math.floor(rand(50, 240)),
    Math.floor(rand(50, 240))
  ];
}

function str16(value = "") {
  const s = String(value).slice(0, 32);
  const b = Buffer.alloc(2 * (s.length + 1));
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
}

function parseString(buf, start) {
  let s = "";
  for (let p = start; p + 1 < buf.length; p += 2) {
    const ch = buf.readUInt16LE(p);
    if (!ch) return [s, p + 2];
    s += String.fromCharCode(ch);
  }
  return [s, buf.length];
}

function send(ws, buf) {
  if (ws && ws.readyState === 1) ws.send(buf);
}

function broadcast(buf) {
  for (const c of clients) send(c.ws, buf);
}

function pktBorder() {
  const b = Buffer.alloc(33);
  b[0] = 64;
  b.writeDoubleLE(-HALF_W, 1);
  b.writeDoubleLE(-HALF_H, 9);
  b.writeDoubleLE(HALF_W, 17);
  b.writeDoubleLE(HALF_H, 25);
  return b;
}

function pktAdd(id) {
  const b = Buffer.alloc(5);
  b[0] = 32;
  b.writeUInt32LE(id >>> 0, 1);
  return b;
}

function pktClear() {
  return Buffer.from([20]);
}

function pktPos(cell) {
  const b = Buffer.alloc(13);
  b[0] = 17;
  b.writeFloatLE(cell?.x || 0, 1);
  b.writeFloatLE(cell?.y || 0, 5);
  b.writeFloatLE(cell?.size || 1, 9);
  return b;
}

function pktLeaderboard() {
  const list = [...clients]
    .filter(c => c.alive)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const parts = [Buffer.from([49]), Buffer.alloc(4)];
  parts[1].writeUInt32LE(list.length, 0);

  for (const c of list) {
    const id = Buffer.alloc(4);
    id.writeUInt32LE((c.primaryCellId || 0) >>> 0, 0);
    parts.push(id, str16(c.name || "UnnamedCell"));
  }
  return Buffer.concat(parts);
}

function pktUpdate() {
  const parts = [Buffer.from([16]), Buffer.alloc(2)];
  parts[1].writeUInt16LE(0, 0);

  for (const cell of cells.values()) {
    const name = str16(cell.name || "");
    const h = Buffer.alloc(14);
    h.writeUInt32LE(cell.id >>> 0, 0);
    h.writeInt16LE(Math.round(cell.x), 4);
    h.writeInt16LE(Math.round(cell.y), 6);
    h.writeInt16LE(Math.round(cell.size), 8);
    h[10] = cell.color[0];
    h[11] = cell.color[1];
    h[12] = cell.color[2];
    h[13] = cell.virus ? 1 : 0;
    parts.push(h, name);
  }

  const terminator = Buffer.alloc(4);
  parts.push(terminator);
  return Buffer.concat(parts);
}

function spawnFood(count = 220) {
  for (let i = 0; i < count; i++) {
    const id = nextId++;
    cells.set(id, {
      id,
      x: rand(-5800, 5800),
      y: rand(-5800, 5800),
      size: 8 + Math.floor(Math.random() * 8),
      color: randomColor(),
      name: "",
      clientId: null,
      virus: false,
      food: true
    });
  }
}

function createPlayerCell(client, size = 45, x, y) {
  const id = nextId++;
  const cell = {
    id,
    x: x ?? rand(-5000, 5000),
    y: y ?? rand(-5000, 5000),
    size,
    color: client.color.slice(),
    name: client.name || "UnnamedCell",
    clientId: client.id,
    virus: false,
    food: false
  };
  cells.set(id, cell);
  client.cells.add(id);
  client.primaryCellId ||= id;
  client.alive = true;
  return cell;
}

function playerCells(client) {
  return [...client.cells]
    .map(id => cells.get(id))
    .filter(Boolean);
}

function recomputeScore(client) {
  client.score = playerCells(client)
    .reduce((sum, c) => sum + c.size * c.size / 100, 0);
  client.alive = playerCells(client).length > 0;
}

function removePlayerCell(client, id) {
  cells.delete(id);
  client.cells.delete(id);
  if (client.primaryCellId === id) {
    client.primaryCellId = [...client.cells][0] || 0;
  }
  recomputeScore(client);
}

function split(client) {
  const source = playerCells(client)
    .filter(c => c.size >= 35)
    .sort((a, b) => b.size - a.size)[0];

  if (!source || client.cells.size >= 16) return;

  const angle = Math.random() * Math.PI * 2;
  const oldSize = source.size;
  const newSize = oldSize * 0.71;
  source.size = newSize;

  const speedOffset = Math.max(80, 2200 / (newSize + 100));
  const cell = createPlayerCell(
    client,
    newSize,
    clamp(source.x + Math.cos(angle) * newSize * 2, -5900, 5900),
    clamp(source.y + Math.sin(angle) * newSize * 2, -5900, 5900)
  );

  cell.x += Math.cos(angle) * speedOffset * 0.15;
  cell.y += Math.sin(angle) * speedOffset * 0.15;
  recomputeScore(client);
}

function eject(client) {
  const source = playerCells(client)
    .filter(c => c.size >= 30)
    .sort((a, b) => b.size - a.size)[0];

  if (!source) return;

  source.size -= 2;
  const angle = Math.random() * Math.PI * 2;
  const id = nextId++;

  cells.set(id, {
    id,
    x: clamp(source.x + Math.cos(angle) * (source.size + 18), -5900, 5900),
    y: clamp(source.y + Math.sin(angle) * (source.size + 18), -5900, 5900),
    size: 12,
    color: source.color.slice(),
    name: "",
    clientId: null,
    virus: false,
    food: true,
    ejected: true
  });
}

function spectate(client) {
  const other = [...clients].find(c => c !== client && c.alive);
  if (!other) return;
  const target = playerCells(other)[0];
  if (target) {
    client.spectating = true;
    client.spectateId = target.id;
  }
}

function handleChat(client, data) {
  const flags = data[1] || 0;
  const [name, p] = parseString(data, 2);
  const [message] = parseString(data, p);
  const clean = String(message || "").slice(0, 500);
  if (!clean) return;

  const payload = Buffer.concat([
    Buffer.from([99, flags & 1, name ? 1 : 0]),
    str16(client.name || name || "UnnamedCell"),
    str16(clean)
  ]);
  broadcast(payload);
}

function handle(client, data) {
  if (!Buffer.isBuffer(data) || !data.length) return;
  const op = data[0];

  if (op === 16 && data.length >= 17) {
    client.targetX = data.readDoubleLE(1);
    client.targetY = data.readDoubleLE(9);
    client.spectating = false;
  } else if (op === 192) {
    const [name] = parseString(data, 1);
    client.name = String(name || "UnnamedCell").slice(0, 32);
    for (const cell of playerCells(client)) cell.name = client.name;
  } else if (op === 17) {
    split(client);
  } else if (op === 21) {
    eject(client);
  } else if (op === 1) {
    spectate(client);
  } else if (op === 206) {
    handleChat(client, data);
  }
}

function updateMovement() {
  for (const client of clients) {
    if (client.spectating && client.spectateId) {
      const target = cells.get(client.spectateId);
      if (target) {
        client.targetX = target.x;
        client.targetY = target.y;
      }
    }

    for (const cell of playerCells(client)) {
      const dx = client.targetX - cell.x;
      const dy = client.targetY - cell.y;
      const len = Math.hypot(dx, dy);
      const speed = Math.max(1.5, 1800 / (cell.size + 100));

      if (len > 2) {
        cell.x = clamp(cell.x + dx / len * speed, -5900, 5900);
        cell.y = clamp(cell.y + dy / len * speed, -5900, 5900);
      }
      cell.name = client.name || "UnnamedCell";
    }
  }
}

function updateEating() {
  const all = [...cells.values()];
  const foods = all.filter(c => c.food && !c.ejected);
  const ejected = all.filter(c => c.ejected);
  const players = all.filter(c => c.clientId !== null && !c.food);

  for (const player of players) {
    for (const food of foods) {
      if (!cells.has(food.id)) continue;
      const reach = player.size + food.size;
      if (dist2(player, food) < reach * reach) {
        player.size += 0.35;
        cells.delete(food.id);
      }
    }

    for (const pellet of ejected) {
      if (!cells.has(pellet.id)) continue;
      const reach = player.size + pellet.size;
      if (dist2(player, pellet) < reach * reach && pellet.clientId !== player.clientId) {
        player.size += 0.5;
        cells.delete(pellet.id);
      }
    }
  }

  // Simple PvP eating: only clearly larger cells can consume smaller ones.
  for (const eater of players) {
    for (const victim of players) {
      if (eater.id === victim.id || eater.clientId === victim.clientId) continue;
      if (eater.size < victim.size * 1.15) continue;

      const reach = Math.max(eater.size * 0.75, 30);
      if (dist2(eater, victim) < reach * reach) {
        eater.size = Math.sqrt(eater.size * eater.size + victim.size * victim.size * 0.75);
        const victimClient = [...clients].find(c => c.id === victim.clientId);
        if (victimClient) removePlayerCell(victimClient, victim.id);
      }
    }
  }
}

spawnFood();

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    return res.end(JSON.stringify({
      ok: true,
      service: "ZeroLegend Agar WebSocket",
      players: clients.size,
      cells: cells.size,
      port: PORT
    }));
  }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("ZeroLegend Agar server online");
});

const wss = new WebSocketServer({
  server: httpServer,
  perMessageDeflate: false,
  maxPayload: 64 * 1024
});

wss.on("connection", (ws) => {
  const client = {
    ws,
    id: Math.random().toString(36).slice(2),
    name: "UnnamedCell",
    color: randomColor(),
    cells: new Set(),
    primaryCellId: 0,
    alive: false,
    score: 0,
    targetX: 0,
    targetY: 0,
    spectating: false,
    spectateId: 0
  };

  clients.add(client);
  ws.binaryType = "arraybuffer";

  send(ws, pktBorder());

  const cell = createPlayerCell(client);
  send(ws, pktAdd(cell.id));
  send(ws, pktLeaderboard());

  ws.on("message", data => {
    try {
      handle(client, Buffer.from(data));
    } catch (_) {}
  });

  ws.on("close", () => {
    for (const id of [...client.cells]) cells.delete(id);
    clients.delete(client);
  });

  ws.on("error", () => {});
});

setInterval(() => {
  updateMovement();
  updateEating();

  if ([...cells.values()].filter(c => c.food).length < 160) spawnFood(80);

  for (const client of clients) recomputeScore(client);

  const update = pktUpdate();
  const leaderboard = pktLeaderboard();

  for (const client of clients) {
    send(client.ws, update);
    const primary = cells.get(client.primaryCellId);
    if (primary) send(client.ws, pktPos(primary));
    send(client.ws, leaderboard);
  }
}, TICK_MS);

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`ZeroLegend Agar server listening on ${PORT}`);
});
