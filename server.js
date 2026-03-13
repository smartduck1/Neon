/**
 * Neon Ultimate - Online Multiplayer Server
 * Run with: node server.js
 * Requires: npm install express socket.io
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Allow all origins for REST API (game is hosted separately on Hostinger)
app.use(cors());
app.use(express.json());

// ======================================================
// DATA PERSISTENCE
// ======================================================
const DATA_FILE = path.join(__dirname, 'server_data.json');

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const d = JSON.parse(raw);
            return {
                leaderboard: {
                    singleplayer: d.leaderboard?.singleplayer || [],
                    multiplayer:  d.leaderboard?.multiplayer  || []
                },
                usernames: d.usernames || []
            };
        }
    } catch (e) { console.error('Data load error:', e.message); }
    return { leaderboard: { singleplayer: [], multiplayer: [] }, usernames: [] };
}

let serverData = loadData();

function saveData() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(serverData, null, 2)); }
    catch (e) { console.error('Data save error:', e.message); }
}

// ======================================================
// REST API
// ======================================================
app.get('/api/leaderboard', (req, res) => {
    const type  = req.query.type  || 'singleplayer';
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    res.json((serverData.leaderboard[type] || []).slice(0, limit));
});

app.post('/api/score', (req, res) => {
    const { username, score, type = 'singleplayer' } = req.body;
    if (!username || typeof score !== 'number' || score < 0)
        return res.status(400).json({ error: 'Invalid data' });

    if (!serverData.leaderboard[type]) serverData.leaderboard[type] = [];
    const board = serverData.leaderboard[type];
    const idx = board.findIndex(e => e.username.toLowerCase() === username.toLowerCase());

    if (idx >= 0) {
        if (score > board[idx].score) {
            board[idx].score = score;
            board[idx].date = new Date().toISOString();
        }
    } else {
        board.push({ username, score, date: new Date().toISOString() });
    }

    board.sort((a, b) => b.score - a.score);
    serverData.leaderboard[type] = board.slice(0, 1000);
    saveData();

    const rank = board.findIndex(e => e.username.toLowerCase() === username.toLowerCase()) + 1;
    res.json({ rank, total: board.length });
    io.emit('leaderboard_updated', { type, top10: board.slice(0, 10) });
});

app.get('/api/username/check', (req, res) => {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Missing name' });
    const taken = serverData.usernames.some(u => u.toLowerCase() === name.toLowerCase());
    res.json({ available: !taken });
});

app.get('/api/stats', (req, res) => {
    res.json({ onlinePlayers: io.engine.clientsCount || 0 });
});

app.post('/api/username/register', (req, res) => {
    const { username } = req.body;
    if (!username || username.length < 2 || username.length > 20)
        return res.status(400).json({ error: 'Username must be 2–20 characters' });
    if (!/^[A-Za-z0-9_\-]+$/.test(username))
        return res.status(400).json({ error: 'Letters, numbers, _ and - only' });
    if (serverData.usernames.some(u => u.toLowerCase() === username.toLowerCase()))
        return res.status(409).json({ error: 'Username already taken' });

    serverData.usernames.push(username);
    saveData();
    res.json({ success: true });
});

// ======================================================
// ROOM MANAGEMENT
// ======================================================
const rooms = new Map(); // roomId → Room

class Room {
    constructor(id, seed, isPublic) {
        this.id = id;
        this.seed = seed;
        this.public = isPublic;
        this.players = [];   // { socketId, username, skin, lane, vertical, score, alive, x, y }
        this.started = false;
        this.startTimer = null;
        this.countdownEnd = null;
    }
}

function genId()   { return Math.random().toString(36).substr(2, 8).toUpperCase(); }
function genSeed() { return Math.floor(Math.random() * 999999).toString().padStart(6, '0'); }

function roomForSocket(socketId) {
    for (const r of rooms.values())
        if (r.players.some(p => p.socketId === socketId)) return r;
    return null;
}

function formatRoom(room) {
    return {
        roomId: room.id, seed: room.seed,
        public: room.public, started: room.started,
        countdownEnd: room.countdownEnd,
        players: room.players.map(p => ({
            socketId: p.socketId, username: p.username,
            skin: p.skin, score: p.score, alive: p.alive
        }))
    };
}

// ======================================================
// SOCKET.IO
// ======================================================
io.on('connection', (socket) => {
    console.log(`[+] ${socket.id}`);

    function leaveRoom() {
        const room = roomForSocket(socket.id);
        if (!room) return;
        room.players = room.players.filter(p => p.socketId !== socket.id);
        socket.leave(room.id);
        socket.to(room.id).emit('player_left', { socketId: socket.id });
        if (room.players.length === 0) {
            if (room.startTimer) clearTimeout(room.startTimer);
            rooms.delete(room.id);
        } else {
            io.to(room.id).emit('lobby_update', formatRoom(room));
        }
    }

    function scheduleStart(room) {
        if (room.startTimer) return;
        room.countdownEnd = Date.now() + 60000;
        io.to(room.id).emit('lobby_countdown', { remainingMs: 60000 });
        room.startTimer = setTimeout(() => startRoom(room), 60000);
    }

    function startRoom(room) {
        if (room.started || room.players.length === 0) return;
        room.started = true;
        if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
        io.to(room.id).emit('game_start', { seed: room.seed, players: formatRoom(room).players });
    }

    function joinRoom(room, username, skin) {
        if (room.players.length >= 4 || room.started) return false;
        leaveRoom();

        room.players.push({
            socketId: socket.id,
            username: username || 'PILOT',
            skin: skin || 'default',
            lane: 1, vertical: 0, score: 0, alive: true, x: 0, y: 0
        });

        socket.join(room.id);
        io.to(room.id).emit('lobby_update', formatRoom(room));
        socket.emit('joined_room', formatRoom(room));

        scheduleStart(room);
        // Send current countdown to this joiner if countdown was already running
        if (room.countdownEnd && room.startTimer) {
            const remainingMs = Math.max(0, room.countdownEnd - Date.now());
            socket.emit('lobby_countdown', { remainingMs });
        }
        if (room.players.length >= 4) startRoom(room);
        return true;
    }

    // ---- Join public lobby ----
    socket.on('join_public', ({ username, skin }) => {
        let target = null;
        for (const r of rooms.values())
            if (r.public && !r.started && r.players.length < 4) { target = r; break; }
        if (!target) {
            const id = genId(), seed = genSeed();
            target = new Room(id, seed, true);
            rooms.set(id, target);
        }
        joinRoom(target, username, skin);
    });

    // ---- Join seed lobby ----
    socket.on('join_seed', ({ username, skin, seed }) => {
        const s = String(seed || '').trim().toUpperCase();
        if (!s) return;
        let target = null;
        for (const r of rooms.values())
            if (r.seed === s && !r.started && r.players.length < 4) { target = r; break; }
        if (!target) {
            const id = genId();
            target = new Room(id, s, false);
            rooms.set(id, target);
        }
        joinRoom(target, username, skin);
    });

    // ---- Player state update ----
    socket.on('player_update', (data) => {
        const room = roomForSocket(socket.id);
        if (!room || !room.started) return;
        const p = room.players.find(p => p.socketId === socket.id);
        if (p) Object.assign(p, {
            lane: data.lane, vertical: data.vertical,
            score: data.score, alive: data.alive,
            x: data.x || 0, y: data.y || 0
        });
        socket.to(room.id).emit('ghost_update', { socketId: socket.id, ...data });

        if (!data.alive) {
            const allDead = room.players.every(pl => !pl.alive);
            if (allDead) {
                const results = [...room.players]
                    .sort((a, b) => b.score - a.score)
                    .map((pl, i) => ({ socketId: pl.socketId, username: pl.username, score: pl.score, rank: i + 1 }));
                io.to(room.id).emit('room_game_over', { results });
                rooms.delete(room.id);
            }
        }
    });

    // ---- Submit score ----
    socket.on('submit_score', ({ score, type, username }) => {
        if (!username || typeof score !== 'number' || score < 0) return;
        const t = type || 'singleplayer';
        if (!serverData.leaderboard[t]) serverData.leaderboard[t] = [];
        const board = serverData.leaderboard[t];
        const idx = board.findIndex(e => e.username.toLowerCase() === username.toLowerCase());
        if (idx >= 0) {
            if (score > board[idx].score) { board[idx].score = score; board[idx].date = new Date().toISOString(); }
        } else {
            board.push({ username, score, date: new Date().toISOString() });
        }
        board.sort((a, b) => b.score - a.score);
        serverData.leaderboard[t] = board.slice(0, 1000);
        saveData();
        const rank = board.findIndex(e => e.username.toLowerCase() === username.toLowerCase()) + 1;
        socket.emit('score_submitted', { rank, total: board.length });
        io.emit('leaderboard_updated', { type: t, top10: board.slice(0, 10) });
    });

    socket.on('exit_lobby', leaveRoom);
    socket.on('disconnect', () => { console.log(`[-] ${socket.id}`); leaveRoom(); });
});

// ======================================================
// START
// ======================================================
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
    console.log(`\n🎮 Neon Ultimate Server running at http://localhost:${PORT}`);
    console.log(`   Serving game files from: ${__dirname}\n`);
});
