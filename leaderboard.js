/**
 * leaderboard.js – Transparent side-panel leaderboard display for Neon Ultimate
 * ES Module – Shows top-10 singleplayer (left) and multiplayer (right) during gameplay.
 */

const SERVER_URL = window.NEON_SERVER ||
    `${window.location.protocol}//${window.location.hostname}:3001`;

export const LeaderboardManager = {
    leftPanel:  null,
    rightPanel: null,
    _interval:  null,

    async fetchTop10(type = 'singleplayer') {
        try {
            const r = await fetch(`${SERVER_URL}/api/leaderboard?type=${type}&limit=10`);
            if (!r.ok) throw new Error();
            return await r.json();
        } catch { return []; }
    },

    _fmt(score) {
        if (score >= 1_000_000) return (score / 1_000_000).toFixed(1) + 'M';
        if (score >= 1_000)     return (score / 1_000).toFixed(1) + 'K';
        return String(score);
    },

    _short(name, max = 10) {
        if (!name) return '???';
        return name.length <= max ? name : name.slice(0, max) + '…';
    },

    _buildPanel(side, title) {
        const el = document.createElement('div');
        el.id = `nu-lb-${side}`;
        const isLeft = side === 'left';
        el.style.cssText = `
            position:fixed;
            top:50%; ${isLeft ? 'left:0' : 'right:0'};
            transform:translateY(-50%);
            background:rgba(0,4,14,.42);
            border-${isLeft ? 'right' : 'left'}:1px solid rgba(0,255,255,.18);
            padding:12px 10px;
            z-index:50;
            min-width:138px;
            max-width:155px;
            pointer-events:none;
            font-family:'Orbitron',sans-serif;
            display:none;
            border-radius:${isLeft ? '0 4px 4px 0' : '4px 0 0 4px'};
        `;
        el.innerHTML = `
            <div style="
                font-size:.55rem;color:rgba(0,255,255,.7);
                letter-spacing:2px;text-align:center;
                border-bottom:1px solid rgba(0,255,255,.15);
                padding-bottom:6px;margin-bottom:8px;
                text-shadow:0 0 8px rgba(0,255,255,.4);
            ">${title}</div>
            <div id="nu-lb-list-${side}" style="display:flex;flex-direction:column;gap:3px;"></div>
        `;
        document.body.appendChild(el);
        return el;
    },

    _renderList(side, entries) {
        const list = document.getElementById(`nu-lb-list-${side}`);
        if (!list) return;
        list.innerHTML = '';

        if (!entries.length) {
            list.innerHTML = `<div style="color:rgba(255,255,255,.25);font-size:.55rem;text-align:center;font-family:'Rajdhani',sans-serif;padding:8px 0;">NO DATA YET</div>`;
            return;
        }

        const rankColors  = ['#ffd700', '#c0c0c0', '#cd7f32'];
        const rankSymbols = ['⭐', '◈', '◆'];
        entries.forEach((e, i) => {
            const rank = i + 1;
            const rc  = rankColors[i]  || 'rgba(255,255,255,.4)';
            const sym = rankSymbols[i] || `#${rank}`;
            const row = document.createElement('div');
            row.style.cssText = `
                display:flex;align-items:center;gap:4px;
                padding:3px 5px;border-radius:2px;
                background:rgba(255,255,255,.025);
                ${rank <= 3 ? `border-left:2px solid ${rc};` : ''}
            `;
            row.innerHTML = `
                <span style="color:${rc};font-size:${i===0?'.6rem':'.5rem'};font-weight:900;min-width:18px;text-align:right;">${sym}</span>
                <span style="color:rgba(255,255,255,.82);font-size:.52rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'Rajdhani',sans-serif;">${this._short(e.username)}</span>
                <span style="color:rgba(0,255,255,.8);font-size:.5rem;font-weight:bold;white-space:nowrap;">${this._fmt(e.score)}</span>
            `;
            list.appendChild(row);
        });
    },

    async init() {
        this.leftPanel  = this._buildPanel('left',  'SP TOP 10');
        this.rightPanel = this._buildPanel('right', 'MP TOP 10');
        await this.refresh();
    },

    async refresh() {
        const [sp, mp] = await Promise.all([
            this.fetchTop10('singleplayer'),
            this.fetchTop10('multiplayer')
        ]);
        this._renderList('left',  sp);
        this._renderList('right', mp);
    },

    show() {
        if (this.leftPanel)  this.leftPanel.style.display  = 'block';
        if (this.rightPanel) this.rightPanel.style.display = 'block';
        if (!this._interval) this._interval = setInterval(() => this.refresh(), 30_000);
    },

    hide() {
        if (this.leftPanel)  this.leftPanel.style.display  = 'none';
        if (this.rightPanel) this.rightPanel.style.display = 'none';
        clearInterval(this._interval); this._interval = null;
    },

    /** Called from Socket.io push updates */
    onServerUpdate(type, top10) {
        const side = type === 'singleplayer' ? 'left' : 'right';
        this._renderList(side, top10);
    },

    /** Render a full leaderboard into an HTML container element (for the MP hub page) */
    renderInto(containerId, entries, accentColor = '#00ffff') {
        const el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML = '';
        if (!entries.length) {
            el.innerHTML = `<div style="color:#555;font-family:'Rajdhani',sans-serif;text-align:center;padding:20px 0;font-size:1rem;">No scores yet — be the first!</div>`;
            return;
        }
        const rankColors  = ['#ffd700', '#c0c0c0', '#cd7f32'];
        const rankSymbols = ['⭐', '◈', '◆'];
        entries.forEach((e, i) => {
            const rank = i + 1;
            const rc  = rankColors[i]  || 'rgba(255,255,255,.4)';
            const sym = rankSymbols[i] || `#${rank}`;
            const name = e.username.length > 16 ? e.username.slice(0, 16) + '…' : e.username;
            const row = document.createElement('div');
            row.style.cssText = `
                display:flex;align-items:center;gap:10px;
                padding:10px 13px;margin-bottom:5px;
                background:rgba(255,255,255,.03);border:1px solid #1e1e2e;
                ${rank <= 3 ? `border-left:3px solid ${rc};` : ''}
            `;
            row.innerHTML = `
                <span style="color:${rc};font-size:${i===0?'1rem':'.8rem'};font-weight:900;min-width:26px;">${sym}</span>
                <span style="color:#e0e0e0;font-size:.9rem;flex:1;font-family:'Rajdhani',sans-serif;letter-spacing:1px;">${name}</span>
                <span style="color:${accentColor};font-size:.9rem;font-weight:bold;">${e.score.toLocaleString()}</span>
            `;
            el.appendChild(row);
        });
    }
};
