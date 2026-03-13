/**
 * multiplayer.js – Online multiplayer client for Neon Ultimate
 * ES Module – handles Socket.io connection, lobby UI, ghost ships, score submission.
 */

import { LeaderboardManager } from './leaderboard.js';
import { UsernameManager }    from './username.js';

const SERVER_URL = window.NEON_SERVER ||
    `${window.location.protocol}//${window.location.hostname}:3001`;

/* ===================================================================
   MultiplayerManager — singleton
   =================================================================== */
export const MultiplayerManager = {
    socket: null,
    connected: false,
    currentRoom: null,
    isInGame: false,
    gameAPI: null,               // set via init()
    ghosts: new Map(),           // socketId → { group, username, targetX, targetY }
    _posInterval: null,
    _countdownInterval: null,

    // -------------------------------------------------------
    // INIT
    // -------------------------------------------------------
    init(gameAPI) {
        this.gameAPI = gameAPI;
        this._buildHubUI();
        this._buildLobbyUI();
        this._loadSocketIO();
        window.MultiplayerManager = this; // expose for inline onclick handlers
    },

    _loadSocketIO() {
        if (window.io) { this._initSocket(); return; }
        const s = document.createElement('script');
        s.src = 'https://cdn.socket.io/4.7.5/socket.io.min.js';
        s.onload  = () => this._initSocket();
        s.onerror = () => console.warn('[MP] Socket.io CDN load failed — offline mode');
        document.head.appendChild(s);
    },

    _initSocket() {
        try {
            this.socket = io(SERVER_URL, { transports: ['websocket', 'polling'], reconnectionAttempts: 5 });

            this.socket.on('connect',    () => { this.connected = true;  console.log('[MP] Connected'); this._updateConnStatus(true); });
            this.socket.on('disconnect', () => { this.connected = false; console.log('[MP] Disconnected'); this._updateConnStatus(false); });

            this.socket.on('joined_room',     d => { this.currentRoom = d; this._updateLobbyUI(d); this._hideSearching(); this._showLobby(); });
            this.socket.on('lobby_update',    d => { this.currentRoom = d; this._updateLobbyUI(d); });
            this.socket.on('lobby_countdown', d => this._startCountdown(d.endsAt));
            this.socket.on('player_left',     d => { this._removeGhost(d.socketId); if(this.currentRoom) { this.currentRoom.players = this.currentRoom.players.filter(p => p.socketId !== d.socketId); this._updateLobbyUI(this.currentRoom); } });
            this.socket.on('game_start',      d => this._onGameStart(d));
            this.socket.on('ghost_update',    d => this._onGhostUpdate(d));
            this.socket.on('room_game_over',  d => this._onRoomGameOver(d));
            this.socket.on('score_submitted', d => console.log(`[MP] Rank ${d.rank}/${d.total}`));
            this.socket.on('leaderboard_updated', d => LeaderboardManager.onServerUpdate(d.type, d.top10));
        } catch(e) { console.warn('[MP] Socket init failed:', e); }
    },

    // -------------------------------------------------------
    // JOIN / LEAVE
    // -------------------------------------------------------
    _ensureUsername(cb) {
        if (!this.connected) { this._showToast('Not connected to server'); return; }
        if (UsernameManager.has()) { cb(); return; }
        UsernameManager.showPrompt(name => { if (name) { this._updateUserBar(); cb(); } });
    },

    joinPublic() {
        this._ensureUsername(() => {
            this._hideHub();
            this._showSearching('SEARCHING FOR PUBLIC LOBBY…');
            this.socket.emit('join_public', { username: UsernameManager.get(), skin: this.gameAPI?.GameData?.activeSkin || 'default' });
        });
    },

    joinSeed(seed) {
        if (!seed) return;
        this._ensureUsername(() => {
            this._hideHub();
            this._showSearching('JOINING SEED LOBBY…');
            this.socket.emit('join_seed', { username: UsernameManager.get(), skin: this.gameAPI?.GameData?.activeSkin || 'default', seed: seed.toUpperCase() });
        });
    },

    exitLobby() {
        if (this.socket) this.socket.emit('exit_lobby');
        this._hideLobby();
        this.currentRoom = null;
        clearInterval(this._countdownInterval);
    },

    submitScore(score, type = 'singleplayer') {
        if (!this.socket || !UsernameManager.has()) return;
        this.socket.emit('submit_score', { score, type, username: UsernameManager.get() });
    },

    // -------------------------------------------------------
    // GAME START / OVER
    // -------------------------------------------------------
    _onGameStart(_data) {
        this._hideLobby();
        this._hideHub();
        this.isInGame = true;
        this._startPosBroadcast();
        // Tell the game to begin
        if (this.gameAPI?.startOnlineGame) this.gameAPI.startOnlineGame();
    },

    _onRoomGameOver(data) {
        this.isInGame = false;
        this._stopPosBroadcast();
        this._clearGhosts();
        LeaderboardManager.hide();

        // Track MP stats for achievements
        const myName = UsernameManager.get().toUpperCase();
        const myIdx  = data.results.findIndex(r => r.username.toUpperCase() === myName);
        if (myIdx >= 0 && this.gameAPI?.GameData) {
            const gd = this.gameAPI.GameData;
            if (!gd.mpStats) gd.mpStats = { gamesPlayed: 0, wins: 0, top3: 0 };
            gd.mpStats.gamesPlayed++;
            if (myIdx === 0) gd.mpStats.wins++;
            if (myIdx < 3)  gd.mpStats.top3++;
            if (gd.save) gd.save();
            if (this.gameAPI.checkAchievements) this.gameAPI.checkAchievements();
        }

        this._showMpResults(data.results);
    },

    // -------------------------------------------------------
    // POSITION BROADCAST
    // -------------------------------------------------------
    _startPosBroadcast() {
        clearInterval(this._posInterval);
        this._posInterval = setInterval(() => {
            if (!this.socket || !this.isInGame) return;
            const s = this.gameAPI?.getPlayerState?.();
            if (s) this.socket.emit('player_update', s);
        }, 50); // ~20 Hz
    },

    _stopPosBroadcast() { clearInterval(this._posInterval); this._posInterval = null; },

    // -------------------------------------------------------
    // GHOST SHIPS
    // -------------------------------------------------------
    _onGhostUpdate(data) {
        if (!this.isInGame || !this.gameAPI) return;
        let g = this.ghosts.get(data.socketId);
        if (!g) {
            const roomPlayer = this.currentRoom?.players?.find(p => p.socketId === data.socketId);
            g = this._createGhost(data.socketId, roomPlayer?.username || 'GHOST');
            if (!g) return;
        }
        g.targetX = this.gameAPI.CONFIG.lanes[data.lane]  ?? 0;
        g.targetY = this.gameAPI.CONFIG.heights[data.vertical] ?? 0;
        if (!data.alive) g.group.visible = false;
    },

    _createGhost(socketId, username) {
        if (!this.gameAPI?.THREE || !this.gameAPI?.scene) return null;
        const THREE = this.gameAPI.THREE;

        const group = new THREE.Group();

        // Ship body (transparent neon cyan)
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
            0,0,-2.5, -1.8,0,1.5, 0,0.6,1.5,
            0,0,-2.5,  0,0.6,1.5, 1.8,0,1.5,
            0,0,-2.5,  0,-0.4,1.5,-1.8,0,1.5,
            0,0,-2.5, 1.8,0,1.5,  0,-0.4,1.5,
           -1.8,0,1.5, 0,-0.4,1.5, 0,0.6,1.5,
            1.8,0,1.5, 0,0.6,1.5,  0,-0.4,1.5
        ]), 3));
        geom.computeVertexNormals();

        const body = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({
            color: 0x003344, emissive: 0x00ffff, emissiveIntensity: 0.25,
            transparent: true, opacity: 0.28, roughness: 0.3, metalness: 0.8
        }));
        const wire = new THREE.LineSegments(
            new THREE.EdgesGeometry(geom),
            new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.55, toneMapped: false })
        );
        group.add(body, wire);

        // Engine glow
        const eng = new THREE.Mesh(
            new THREE.ConeGeometry(.5, 2, 8, 1, true),
            new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending })
        );
        eng.rotation.x = Math.PI / 2; eng.position.z = 1.8;
        group.add(eng);

        // Name label (canvas texture)
        const canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 56;
        const ctx = canvas.getContext('2d');
        ctx.font = 'bold 24px Orbitron, monospace';
        ctx.fillStyle = 'rgba(0,255,255,.92)';
        ctx.textAlign = 'center';
        const shortName = username.length > 10 ? username.slice(0, 10) : username;
        ctx.fillText(shortName.toUpperCase(), 128, 36);
        const tex = new THREE.CanvasTexture(canvas);
        const label = new THREE.Mesh(
            new THREE.PlaneGeometry(4.5, 1),
            new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
        );
        label.position.set(0, 2.4, 0); label.renderOrder = 2;
        group.add(label);

        group.position.y = this.gameAPI.CONFIG.heights[0];
        this.gameAPI.scene.add(group);

        const ghostObj = { group, username, targetX: 0, targetY: this.gameAPI.CONFIG.heights[0] };
        this.ghosts.set(socketId, ghostObj);
        return ghostObj;
    },

    _removeGhost(socketId) {
        const g = this.ghosts.get(socketId);
        if (g && this.gameAPI?.scene) this.gameAPI.scene.remove(g.group);
        this.ghosts.delete(socketId);
    },

    _clearGhosts() {
        this.ghosts.forEach((g) => { if (this.gameAPI?.scene) this.gameAPI.scene.remove(g.group); });
        this.ghosts.clear();
    },

    /** Called each frame from the game's animate() to smoothly lerp ghosts */
    tickGhosts(timeFactor) {
        this.ghosts.forEach(g => {
            if (!g.group.visible) return;
            g.group.position.x += (g.targetX - g.group.position.x) * Math.min(1, 0.18 * timeFactor);
            g.group.position.y += (g.targetY - g.group.position.y) * Math.min(1, 0.18 * timeFactor);
        });
    },

    // -------------------------------------------------------
    // HUB UI
    // -------------------------------------------------------
    _buildHubUI() {
        const el = document.createElement('div');
        el.id = 'nu-mp-hub';
        el.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,14,.97);
            backdrop-filter:blur(20px);z-index:900;display:none;
            font-family:'Orbitron',sans-serif;overflow-y:auto;
        `;
        el.innerHTML = `
        <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 18px;box-sizing:border-box;max-width:900px;margin:0 auto;">

          <!-- Header -->
          <div style="width:100%;display:flex;justify-content:space-between;align-items:center;margin-bottom:26px;">
            <div>
              <div style="font-size:1.8rem;color:#00ffff;font-weight:900;letter-spacing:4px;text-shadow:0 0 20px #00ffff;">ONLINE</div>
              <div id="nu-hub-playercount" style="color:#00ff88;font-size:.6rem;letter-spacing:2px;margin-top:3px;font-family:'Rajdhani',sans-serif;"></div>
            </div>
            <button id="nu-hub-back" style="
              background:transparent;border:1px solid #444;color:#888;
              font-family:'Orbitron',sans-serif;font-size:.8rem;
              padding:8px 16px;cursor:pointer;letter-spacing:1px;transition:.18s;border-radius:2px;
            ">← BACK</button>
          </div>

          <!-- Callsign bar -->
          <div style="
            width:100%;background:rgba(0,8,25,.75);
            border:1px solid rgba(0,255,255,.2);
            padding:12px 18px;margin-bottom:18px;
            display:flex;justify-content:space-between;align-items:center;border-radius:2px;
            box-sizing:border-box;
          ">
            <div>
              <div style="color:#555;font-size:.6rem;letter-spacing:2px;margin-bottom:3px;">CALLSIGN</div>
              <div id="nu-hub-username" style="color:#00ffff;font-size:1.15rem;font-weight:900;letter-spacing:3px;">—</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <div id="nu-hub-conn" style="font-size:.6rem;letter-spacing:1px;color:#555;">OFFLINE</div>
              <button id="nu-hub-changename" style="
                background:transparent;border:1px solid rgba(0,255,255,.25);color:rgba(0,255,255,.55);
                font-family:'Orbitron',sans-serif;font-size:.65rem;padding:6px 12px;
                cursor:pointer;letter-spacing:1px;border-radius:2px;transition:.18s;
              ">CHANGE</button>
            </div>
          </div>

          <!-- Tabs -->
          <div style="width:100%;display:flex;border-bottom:1px solid #1e1e30;margin-bottom:0;">
            <button class="nu-hub-tab" data-sec="nu-hub-play" style="
              flex:1;padding:12px;background:rgba(0,255,255,.08);
              border:1px solid rgba(0,255,255,.25);border-bottom:none;
              color:#00ffff;font-family:'Orbitron',sans-serif;font-size:.75rem;
              cursor:pointer;letter-spacing:2px;transition:.18s;
            ">PLAY</button>
            <button class="nu-hub-tab" data-sec="nu-hub-lb" style="
              flex:1;padding:12px;background:transparent;
              border:1px solid #252535;border-bottom:none;border-left:none;
              color:#555;font-family:'Orbitron',sans-serif;font-size:.75rem;
              cursor:pointer;letter-spacing:2px;transition:.18s;
            ">LEADERBOARD</button>
          </div>

          <!-- PLAY section -->
          <div id="nu-hub-play" style="
            width:100%;border:1px solid #1e1e30;border-top:none;
            padding:24px;box-sizing:border-box;background:rgba(0,3,12,.6);
          ">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px;">

              <!-- Public lobby card -->
              <div style="
                background:rgba(0,255,255,.03);border:1px solid rgba(0,255,255,.18);
                padding:24px 18px;text-align:center;border-radius:2px;
              ">
                <div style="font-size:1.8rem;margin-bottom:10px;">🌐</div>
                <div style="color:#00ffff;font-size:.95rem;font-weight:900;letter-spacing:2px;margin-bottom:8px;">PUBLIC LOBBY</div>
                <div style="color:#666;font-size:.75rem;margin-bottom:18px;font-family:'Rajdhani',sans-serif;line-height:1.5;">
                  Join any available game with random pilots worldwide.
                </div>
                <button id="nu-hub-join-public" style="
                  width:100%;padding:13px;
                  background:rgba(0,255,255,.08);border:2px solid #00ffff;color:#00ffff;
                  font-family:'Orbitron',sans-serif;font-size:.85rem;
                  cursor:pointer;letter-spacing:2px;transition:.18s;border-radius:2px;
                ">JOIN</button>
              </div>

              <!-- Seed lobby card -->
              <div style="
                background:rgba(255,0,204,.03);border:1px solid rgba(255,0,204,.18);
                padding:24px 18px;text-align:center;border-radius:2px;
              ">
                <div style="font-size:1.8rem;margin-bottom:10px;">🔑</div>
                <div style="color:#ff00cc;font-size:.95rem;font-weight:900;letter-spacing:2px;margin-bottom:8px;">SEED LOBBY</div>
                <div style="color:#666;font-size:.75rem;margin-bottom:10px;font-family:'Rajdhani',sans-serif;line-height:1.5;">
                  Share the code with friends to play together.
                </div>
                <input id="nu-hub-seed-input" type="text" maxlength="10"
                  placeholder="ENTER SEED" autocomplete="off"
                  style="
                    width:100%;box-sizing:border-box;
                    background:rgba(255,0,204,.05);border:1px solid rgba(255,0,204,.3);
                    color:#fff;font-family:'Orbitron',sans-serif;font-size:.9rem;
                    padding:10px;text-align:center;letter-spacing:3px;
                    margin-bottom:10px;outline:none;border-radius:2px;
                    text-transform:uppercase;
                  ">
                <button id="nu-hub-join-seed" style="
                  width:100%;padding:13px;
                  background:rgba(255,0,204,.08);border:2px solid #ff00cc;color:#ff00cc;
                  font-family:'Orbitron',sans-serif;font-size:.85rem;
                  cursor:pointer;letter-spacing:2px;transition:.18s;border-radius:2px;
                ">JOIN BY SEED</button>
              </div>
            </div>
            <div style="color:#444;font-size:.65rem;text-align:center;font-family:'Rajdhani',sans-serif;">
              Up to 4 pilots • 60-second lobby countdown • Other players appear as ghost ships • No split-screen
            </div>
          </div>

          <!-- LEADERBOARD section -->
          <div id="nu-hub-lb" style="
            width:100%;border:1px solid #1e1e30;border-top:none;
            padding:24px;box-sizing:border-box;background:rgba(0,3,12,.6);display:none;
          ">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:22px;">
              <div>
                <div style="color:#00ffff;font-size:.8rem;font-weight:900;letter-spacing:3px;margin-bottom:12px;border-bottom:1px solid rgba(0,255,255,.18);padding-bottom:8px;">SINGLEPLAYER</div>
                <div id="nu-lb-sp-full"></div>
              </div>
              <div>
                <div style="color:#ff00cc;font-size:.8rem;font-weight:900;letter-spacing:3px;margin-bottom:12px;border-bottom:1px solid rgba(255,0,204,.18);padding-bottom:8px;">MULTIPLAYER</div>
                <div id="nu-lb-mp-full"></div>
              </div>
            </div>
            <button id="nu-hub-lb-refresh" style="
              margin-top:20px;padding:10px 22px;
              background:transparent;border:1px solid #333;color:#555;
              font-family:'Orbitron',sans-serif;font-size:.7rem;
              cursor:pointer;letter-spacing:2px;transition:.18s;border-radius:2px;
            ">REFRESH</button>
          </div>

        </div>`;

        document.body.appendChild(el);

        // --- Tab switching ---
        el.querySelectorAll('.nu-hub-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                el.querySelectorAll('.nu-hub-tab').forEach(t => {
                    t.style.background = 'transparent'; t.style.color = '#555';
                    t.style.borderColor = '#252535';
                    const sec = document.getElementById(t.dataset.sec);
                    if (sec) sec.style.display = 'none';
                });
                tab.style.background = 'rgba(0,255,255,.08)';
                tab.style.color = '#00ffff'; tab.style.borderColor = 'rgba(0,255,255,.25)';
                const sec = document.getElementById(tab.dataset.sec);
                if (sec) sec.style.display = 'block';
                if (tab.dataset.sec === 'nu-hub-lb') this._refreshHubLB();
            });
        });

        document.getElementById('nu-hub-back').onclick = () => {
            this._hideHub();
            document.getElementById('overlay').style.display = 'flex';
        };
        document.getElementById('nu-hub-changename').onclick = () => {
            UsernameManager.showPrompt(n => { if (n) this._updateUserBar(); });
        };
        document.getElementById('nu-hub-join-public').onclick = () => this.joinPublic();
        document.getElementById('nu-hub-join-seed').onclick = () => {
            const seed = document.getElementById('nu-hub-seed-input').value.trim();
            if (!seed) { document.getElementById('nu-hub-seed-input').style.borderColor = '#ff4444'; setTimeout(() => document.getElementById('nu-hub-seed-input').style.borderColor = 'rgba(255,0,204,.3)', 1200); return; }
            this.joinSeed(seed);
        };
        document.getElementById('nu-hub-lb-refresh').onclick = () => this._refreshHubLB();

        // Button hover helpers
        this._addHover('nu-hub-join-public', 'rgba(0,255,255,.25)', '#00ffff');
        this._addHover('nu-hub-join-seed',   'rgba(255,0,204,.25)', '#ff00cc');
    },

    _addHover(id, bgHover) {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('mouseenter', () => { btn.style.background = bgHover; });
        btn.addEventListener('mouseleave', () => { btn.style.background = `${bgHover.split(',')[0]},${bgHover.split(',')[1]},${bgHover.split(',')[2]},.08)`; });
    },

    async showHub() {
        document.getElementById('nu-mp-hub').style.display = 'flex';
        document.getElementById('overlay').style.display = 'none';
        this._updateUserBar();
        // Fetch live player count
        try {
            const r = await fetch(`${SERVER_URL}/api/stats`);
            if (r.ok) {
                const d = await r.json();
                const el = document.getElementById('nu-hub-playercount');
                if (el) el.textContent = `${d.onlinePlayers} PILOT${d.onlinePlayers !== 1 ? 'S' : ''} ONLINE`;
            }
        } catch(_) {}
    },

    _hideHub() { document.getElementById('nu-mp-hub').style.display = 'none'; },

    _updateUserBar() {
        const el = document.getElementById('nu-hub-username');
        if (el) el.textContent = UsernameManager.get() || '— SET CALLSIGN —';
    },

    _updateConnStatus(online) {
        const el = document.getElementById('nu-hub-conn');
        if (el) {
            el.textContent = online ? '● ONLINE' : '○ OFFLINE';
            el.style.color  = online ? '#00ff88' : '#555';
        }
        // Update the main menu ONLINE button with a live indicator
        const onlineBtn = document.getElementById('onlineBtn');
        if (onlineBtn) {
            onlineBtn.textContent = online ? '● ONLINE' : '🌐 ONLINE';
            onlineBtn.style.boxShadow = online
                ? '0 0 25px rgba(0,255,136,.5), 0 0 8px rgba(0,255,136,.8) inset'
                : '';
        }
    },

    async _refreshHubLB() {
        const [sp, mp] = await Promise.all([
            LeaderboardManager.fetchTop10('singleplayer'),
            LeaderboardManager.fetchTop10('multiplayer')
        ]);
        LeaderboardManager.renderInto('nu-lb-sp-full', sp, '#00ffff');
        LeaderboardManager.renderInto('nu-lb-mp-full', mp, '#ff00cc');
    },

    // -------------------------------------------------------
    // LOBBY UI
    // -------------------------------------------------------
    _buildLobbyUI() {
        const el = document.createElement('div');
        el.id = 'nu-lobby';
        el.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,14,.95);
            backdrop-filter:blur(20px);z-index:950;display:none;
            justify-content:center;align-items:center;
            font-family:'Orbitron',sans-serif;
        `;
        el.innerHTML = `
        <div style="
          background:rgba(0,8,25,.92);border:2px solid rgba(0,255,255,.35);
          box-shadow:0 0 60px rgba(0,255,255,.12);
          padding:28px 30px;border-radius:4px;width:90%;max-width:520px;
        ">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
            <div style="font-size:1.4rem;color:#00ffff;font-weight:900;letter-spacing:3px;text-shadow:0 0 15px #00ffff;">LOBBY</div>
            <div style="display:flex;gap:8px;align-items:center;">
              <span id="nu-lobby-seed" style="color:#444;font-size:.65rem;letter-spacing:1px;"></span>
              <div id="nu-lobby-badge" style="
                padding:3px 10px;font-size:.6rem;letter-spacing:2px;
                background:rgba(0,255,255,.08);border:1px solid rgba(0,255,255,.25);color:#00ffff;border-radius:2px;
              ">PUBLIC</div>
            </div>
          </div>

          <div id="nu-lobby-players" style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;min-height:190px;"></div>

          <div style="background:rgba(0,0,0,.45);border:1px solid #1e1e30;padding:14px;margin-bottom:18px;text-align:center;border-radius:2px;">
            <div style="color:#888;font-size:.6rem;letter-spacing:2px;margin-bottom:6px;">LAUNCHING IN</div>
            <div id="nu-lobby-countdown" style="font-size:2.8rem;color:#00ffff;font-weight:900;text-shadow:0 0 20px #00ffff;line-height:1;">--</div>
            <div style="color:#333;font-size:.6rem;margin-top:4px;">OR WHEN 4 PILOTS JOIN</div>
          </div>

          <button id="nu-lobby-exit" style="
            width:100%;padding:13px;
            background:transparent;border:1px solid rgba(255,50,50,.5);color:rgba(255,80,80,.8);
            font-family:'Orbitron',sans-serif;font-size:.85rem;
            cursor:pointer;letter-spacing:2px;transition:.18s;border-radius:2px;
          ">EXIT LOBBY</button>
        </div>`;

        document.body.appendChild(el);

        document.getElementById('nu-lobby-exit').onclick = () => {
            this.exitLobby();
            this.showHub();
        };
    },

    _showLobby() {
        document.getElementById('nu-lobby').style.display = 'flex';
        this._hideHub();
    },

    _hideLobby() { document.getElementById('nu-lobby').style.display = 'none'; },

    _updateLobbyUI(room) {
        const seedEl = document.getElementById('nu-lobby-seed');
        const badge  = document.getElementById('nu-lobby-badge');
        const list   = document.getElementById('nu-lobby-players');
        if (!list) return;

        if (seedEl) seedEl.textContent = `SEED: ${room.seed}`;
        if (badge)  badge.textContent  = room.public ? 'PUBLIC' : 'PRIVATE';

        list.innerHTML = '';
        for (let i = 0; i < 4; i++) {
            const p = room.players[i];
            const isMe = p && p.socketId === this.socket?.id;
            const slot = document.createElement('div');
            slot.style.cssText = `
                padding:13px 16px;
                background:${p ? 'rgba(0,255,255,.04)' : 'rgba(255,255,255,.01)'};
                border:1px solid ${p ? 'rgba(0,255,255,.28)' : '#1a1a2a'};
                display:flex;justify-content:space-between;align-items:center;
                border-radius:2px;transition:.3s;
            `;
            if (p) {
                slot.innerHTML = `
                    <div style="display:flex;align-items:center;gap:10px;">
                        <div style="width:8px;height:8px;background:#00ff88;border-radius:50%;box-shadow:0 0 6px #00ff88;"></div>
                        <span style="color:#fff;font-size:.9rem;font-weight:900;letter-spacing:2px;">${p.username.toUpperCase()}</span>
                        ${isMe ? '<span style="color:#00ffff;font-size:.55rem;border:1px solid rgba(0,255,255,.3);padding:2px 6px;border-radius:2px;">YOU</span>' : ''}
                    </div>
                    <span style="color:#00ff88;font-size:.6rem;letter-spacing:2px;">READY</span>
                `;
            } else {
                slot.innerHTML = `
                    <div style="display:flex;align-items:center;gap:10px;">
                        <div style="width:8px;height:8px;background:#222;border-radius:50%;"></div>
                        <span style="color:#333;font-size:.75rem;letter-spacing:2px;">WAITING FOR PILOT…</span>
                    </div>
                    <div style="width:16px;height:1px;background:#333;"></div>
                `;
            }
            list.appendChild(slot);
        }
    },

    _startCountdown(endsAt) {
        clearInterval(this._countdownInterval);
        const el = document.getElementById('nu-lobby-countdown');
        this._countdownInterval = setInterval(() => {
            const rem = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
            if (el) { el.textContent = rem; el.style.color = rem <= 10 ? '#ff4444' : '#00ffff'; el.style.textShadow = rem <= 10 ? '0 0 20px #ff4444' : '0 0 20px #00ffff'; }
            if (rem <= 0) clearInterval(this._countdownInterval);
        }, 100);
    },

    // -------------------------------------------------------
    // MP RESULTS OVERLAY
    // -------------------------------------------------------
    _showMpResults(results) {
        const existing = document.getElementById('nu-mp-results');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.id = 'nu-mp-results';
        el.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,.94);z-index:5000;
            display:flex;flex-direction:column;justify-content:center;align-items:center;
            font-family:'Orbitron',sans-serif;animation:modalPop .5s ease;
        `;

        const medals = ['🏆','🥈','🥉','💀'];
        const rankColors = ['#ffd700','#c0c0c0','#cd7f32','#444'];

        const rows = results.map((r, i) => `
            <div style="
                display:flex;align-items:center;gap:18px;
                padding:16px 22px;margin-bottom:10px;
                border:1px solid ${i===0?'#ffd700':'#222'};
                background:${i===0?'rgba(255,215,0,.08)':'rgba(255,255,255,.02)'};
                box-shadow:${i===0?'0 0 20px rgba(255,215,0,.15)':'none'};
                min-width:340px;border-radius:2px;
                animation:slideIn .4s ease ${i*0.12}s backwards;
            ">
                <span style="font-size:1.8rem;">${medals[i]||'💀'}</span>
                <span style="flex:1;color:#fff;font-size:1.1rem;font-weight:900;letter-spacing:2px;">${r.username.toUpperCase()}</span>
                <span style="color:${rankColors[i]||'#00ffff'};font-size:1.2rem;font-weight:900;">${r.score.toLocaleString()}</span>
            </div>
        `).join('');

        el.innerHTML = `
            <div style="font-size:1.8rem;color:#fff;margin-bottom:28px;font-weight:900;letter-spacing:4px;text-shadow:0 0 20px #00ffff;">MATCH RESULTS</div>
            ${rows}
            <div style="display:flex;gap:14px;margin-top:28px;">
                <button onclick="document.getElementById('nu-mp-results').remove();window.MultiplayerManager.showHub();" style="
                    padding:14px 28px;background:rgba(0,255,255,.08);border:2px solid #00ffff;color:#00ffff;
                    font-family:'Orbitron',sans-serif;font-size:.9rem;cursor:pointer;letter-spacing:2px;border-radius:2px;
                ">PLAY AGAIN</button>
                <button onclick="document.getElementById('nu-mp-results').remove();document.getElementById('overlay').style.display='flex';" style="
                    padding:14px 28px;background:transparent;border:1px solid #444;color:#888;
                    font-family:'Orbitron',sans-serif;font-size:.9rem;cursor:pointer;letter-spacing:2px;border-radius:2px;
                ">MAIN MENU</button>
            </div>
        `;
        document.body.appendChild(el);
    },

    _showSearching(msg = 'SEARCHING…') {
        const existing = document.getElementById('nu-searching');
        if (existing) existing.remove();
        if (!document.getElementById('nu-spin-style')) {
            const st = document.createElement('style');
            st.id = 'nu-spin-style';
            st.textContent = `
                @keyframes nuSpin   { to { transform:rotate(360deg); } }
                @keyframes nuPulse  { 0%,100%{opacity:1;} 50%{opacity:0.35;} }
            `;
            document.head.appendChild(st);
        }
        const el = document.createElement('div');
        el.id = 'nu-searching';
        el.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,14,.97);
            z-index:960;display:flex;flex-direction:column;
            justify-content:center;align-items:center;
            font-family:'Orbitron',sans-serif;
        `;
        el.innerHTML = `
            <div style="width:56px;height:56px;border-radius:50%;
                border:3px solid rgba(0,255,255,.12);border-top:3px solid #00ffff;
                animation:nuSpin 1s linear infinite;margin-bottom:28px;"></div>
            <div style="color:#00ffff;font-size:.85rem;letter-spacing:4px;
                text-shadow:0 0 10px #00ffff;animation:nuPulse 1.6s ease-in-out infinite;">${msg}</div>
            <button id="nu-search-cancel" style="
                margin-top:28px;padding:10px 22px;background:transparent;
                border:1px solid rgba(255,80,80,.4);color:rgba(255,80,80,.7);
                font-family:'Orbitron',sans-serif;font-size:.7rem;
                cursor:pointer;letter-spacing:1px;border-radius:2px;transition:.18s;
            ">CANCEL</button>
        `;
        document.body.appendChild(el);
        document.getElementById('nu-search-cancel').onclick = () => {
            this._hideSearching();
            this.showHub();
        };
    },

    _hideSearching() {
        const el = document.getElementById('nu-searching');
        if (el) el.remove();
    },

    _showToast(msg) {
        const t = document.createElement('div');
        t.style.cssText = `
            position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            background:rgba(0,0,0,.85);border:1px solid #ff4444;color:#ff4444;
            font-family:'Orbitron',sans-serif;font-size:.75rem;letter-spacing:2px;
            padding:10px 20px;z-index:9999;border-radius:2px;pointer-events:none;
            animation:fadeIn .3s ease;
        `;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    }
};
