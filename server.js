// server.js
// Backend: Express + Socket.IO + SQLite
// - Регистрация / логин через HTTP (хранение в SQLite)
// - Синхронизация мира и игроков через Socket.IO (WebSocket)
// - Хранение состояния мира (блоки) в SQLite

const express = require('express');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_for_prod';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// --- DB setup ---
const db = new sqlite3.Database('./world.db');

db.serialize(() => {
  // users: id, username, password_hash
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT
  )`);

  // blocks: x,y,z,type (string), color (hex)
  db.run(`CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    x INTEGER,
    y INTEGER,
    z INTEGER,
    type TEXT,
    color TEXT,
    UNIQUE(x,y,z)
  )`);
});

// --- Sample world generation (if empty) ---
function ensureSampleWorld() {
  db.get("SELECT COUNT(*) as cnt FROM blocks", (err, row) => {
    if (err) return console.error(err);
    if (row.cnt === 0) {
      const stmt = db.prepare("INSERT INTO blocks (x,y,z,type,color) VALUES (?,?,?,?,?)");
      // a simple little platform and a tower for testing
      for (let x=-4; x<=4; x++){
        for (let z=-4; z<=4; z++){
          stmt.run(x, 0, z, 'dirt', '#8B5A2B');
        }
      }
      // a few colored blocks (tower)
      stmt.run(0,1,0,'stone','#888888');
      stmt.run(0,2,0,'stone','#888888');
      stmt.run(1,1,0,'grass','#4CAF50');
      stmt.finalize();
      console.log("Sample world created.");
    }
  });
}
ensureSampleWorld();

// --- Auth endpoints ---
// Registration
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const hash = await bcrypt.hash(password, 10);
  db.run("INSERT INTO users (username, password_hash) VALUES (?,?)", [username, hash], function(err) {
    if (err) {
      console.error(err);
      return res.status(400).json({ error: 'Username already exists' });
    }
    const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET);
    res.json({ token, username });
  });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    if (!row) return res.status(400).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: row.id, username }, JWT_SECRET);
    res.json({ token, username });
  });
});

// --- In-memory state for players ---
// players: { socketId: { id, username, x,y,z, color } }
const players = {};

// --- Helper: load all blocks from DB ---
function loadAllBlocks(callback) {
  db.all("SELECT x,y,z,type,color FROM blocks", (err, rows) => {
    if (err) return callback(err);
    callback(null, rows);
  });
}

// --- Socket.IO real-time sync ---
// We expect clients to connect with token: io.connect('/', { auth: { token } })
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error("Authentication error"));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    return next();
  } catch (e) {
    return next(new Error("Authentication error"));
  }
});

io.on('connection', (socket) => {
  const username = socket.user.username;
  console.log(`Socket connected: ${socket.id} (${username})`);

  // add to players with spawn position
  // simple spawn: somewhere near origin
  const spawn = { x: Math.random()*2 -1, y: 2, z: Math.random()*2 -1 };
  const color = '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6,'0');

  players[socket.id] = {
    id: socket.user.id,
    username,
    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    color
  };

  // Send initial world + other players to this client
  loadAllBlocks((err, blocks) => {
    if (err) {
      console.error(err);
      return;
    }
    // 'init' contains current world state and current players
    socket.emit('init', { blocks, players });
  });

  // Notify others about new player
  socket.broadcast.emit('player_join', { socketId: socket.id, player: players[socket.id] });

  // --- Handle player movement updates ---
  // client emits 'move' with {x,y,z,rotY,...}
  socket.on('move', (data) => {
    // update in-memory position
    if (!players[socket.id]) return;
    players[socket.id].x = data.x;
    players[socket.id].y = data.y;
    players[socket.id].z = data.z;
    // broadcast to others
    socket.broadcast.emit('player_move', { socketId: socket.id, pos: { x: data.x, y: data.y, z: data.z } });
  });

  // --- Handle block placement ---
  // client emits 'place_block' with {x,y,z,type,color}
  socket.on('place_block', (b) => {
    // ensure integers
    const x = Math.floor(b.x), y = Math.floor(b.y), z = Math.floor(b.z);
    // insert or ignore if exists
    db.run("INSERT OR IGNORE INTO blocks (x,y,z,type,color) VALUES (?,?,?,?)", [x,y,z,b.type,b.color], function(err) {
      if (err) {
        console.error("DB insert error:", err);
        return;
      }
      // also update in-memory? we always read from DB for new clients but we can broadcast new block
      const block = { x,y,z,type:b.type,color:b.color };
      io.emit('block_placed', block); // broadcast to everyone
    });
  });

  // --- Handle block breaking ---
  // client emits 'break_block' with {x,y,z}
  socket.on('break_block', (b) => {
    const x = Math.floor(b.x), y = Math.floor(b.y), z = Math.floor(b.z);
    db.run("DELETE FROM blocks WHERE x=? AND y=? AND z=?", [x,y,z], function(err) {
      if (err) {
        console.error("DB delete error:", err);
        return;
      }
      io.emit('block_removed', { x,y,z });
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id} (${username})`);
    delete players[socket.id];
    socket.broadcast.emit('player_leave', { socketId: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
