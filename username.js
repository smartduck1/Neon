/**
 * username.js – Callsign / username management for Neon Ultimate Online
 * ES Module – imported by multiplayer.js and index.html
 */

const SERVER_URL = window.NEON_SERVER ||
    `${window.location.protocol}//${window.location.hostname}:3001`;

export const UsernameManager = {
    _key: 'neonOnlineUsername',

    get()    { return localStorage.getItem(this._key) || ''; },
    set(n)   { localStorage.setItem(this._key, n); },
    has()    { return !!this.get(); },

    async checkAvailable(name) {
        try {
            const r = await fetch(`${SERVER_URL}/api/username/check?name=${encodeURIComponent(name)}`);
            if (!r.ok) return true; // optimistic if server unreachable
            return (await r.json()).available;
        } catch { return true; }
    },

    async register(name) {
        try {
            const r = await fetch(`${SERVER_URL}/api/username/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: name })
            });
            return r.ok;
        } catch { return false; }
    },

    /** Show the callsign prompt modal.
     *  onDone(name|null) — name if registered, null if skipped. */
    showPrompt(onDone) {
        const existing = document.getElementById('nu-username-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'nu-username-modal';
        overlay.style.cssText = `
            position:fixed; inset:0; background:rgba(0,0,0,0.92);
            display:flex; justify-content:flex-start; align-items:flex-start;
            overflow-y:auto; padding:20px; box-sizing:border-box;
            z-index:9500; font-family:'Orbitron',sans-serif;
            animation:modalPop .35s ease;
        `;

        overlay.innerHTML = `
        <div style="
            background:rgba(0,8,25,0.97);
            border:2px solid #00ffff;
            box-shadow:0 0 50px rgba(0,255,255,.25);
            padding:32px 36px; border-radius:4px;
            text-align:center; width:100%; max-width:440px;
            margin:auto;
        ">
            <div style="font-size:1.6rem;color:#00ffff;font-weight:900;
                letter-spacing:3px;text-shadow:0 0 20px #00ffff;margin-bottom:10px;">
                PILOT REGISTRATION
            </div>
            <div style="color:#888;font-family:'Rajdhani',sans-serif;
                font-size:1rem;margin-bottom:24px;line-height:1.5;">
                Create a unique callsign to appear on leaderboards.<br>
                Letters, numbers, _ and – only (2–20 chars).
            </div>
            <input id="nu-un-input" type="text" maxlength="20" placeholder="YOUR CALLSIGN"
                autocomplete="off" autocorrect="off" autocapitalize="characters"
                style="
                    width:100%;box-sizing:border-box;
                    background:rgba(0,255,255,.05);
                    border:2px solid #00ffff;border-radius:2px;
                    color:#fff;font-family:'Orbitron',sans-serif;
                    font-size:1.15rem;padding:12px 14px;
                    text-align:center;letter-spacing:3px;
                    margin-bottom:8px;outline:none;
                    text-transform:uppercase;
                ">
            <div id="nu-un-status" style="
                height:22px;font-size:.85rem;color:#888;
                font-family:'Rajdhani',sans-serif;margin-bottom:18px;
            "></div>
            <div style="display:flex;gap:12px;">
                <button id="nu-un-reg-btn" style="
                    flex:2;padding:14px 8px;
                    background:transparent;border:2px solid #00ffff;
                    color:#00ffff;font-family:'Orbitron',sans-serif;
                    font-size:.95rem;cursor:pointer;letter-spacing:2px;
                    transition:.18s;border-radius:2px;
                ">REGISTER</button>
                <button id="nu-un-skip-btn" style="
                    flex:1;padding:14px 8px;
                    background:transparent;border:1px solid #444;
                    color:#555;font-family:'Orbitron',sans-serif;
                    font-size:.8rem;cursor:pointer;letter-spacing:1px;
                    transition:.18s;border-radius:2px;
                ">SKIP</button>
            </div>
        </div>`;

        document.body.appendChild(overlay);

        const input  = overlay.querySelector('#nu-un-input');
        const status = overlay.querySelector('#nu-un-status');
        const regBtn = overlay.querySelector('#nu-un-reg-btn');
        const skipBtn= overlay.querySelector('#nu-un-skip-btn');

        let checkTimer = null;
        let isAvailable = false;

        const setStatus = (msg, color) => { status.textContent = msg; status.style.color = color; };

        input.addEventListener('input', () => {
            let v = input.value.toUpperCase().replace(/[^A-Z0-9_\-]/g, '');
            if (input.value !== v) input.value = v;
            if (v.length < 2) { setStatus('Minimum 2 characters', '#888'); isAvailable = false; return; }
            setStatus('Checking…', '#aaa');
            isAvailable = false;
            clearTimeout(checkTimer);
            checkTimer = setTimeout(async () => {
                const avail = await UsernameManager.checkAvailable(v);
                isAvailable = avail;
                setStatus(avail ? '✓ Available!' : '✗ Already taken', avail ? '#00ff88' : '#ff4444');
            }, 600);
        });

        const hoverOn  = (b, col) => { b.style.background = col; b.style.color = col === 'transparent' ? '#fff' : '#000'; };
        const hoverOff = (b, col) => { b.style.background = 'transparent'; b.style.color = col; };
        regBtn.addEventListener('mouseenter', () => hoverOn(regBtn, '#00ffff'));
        regBtn.addEventListener('mouseleave', () => hoverOff(regBtn, '#00ffff'));
        skipBtn.addEventListener('mouseenter', () => { skipBtn.style.color = '#aaa'; skipBtn.style.borderColor = '#aaa'; });
        skipBtn.addEventListener('mouseleave', () => { skipBtn.style.color = '#555'; skipBtn.style.borderColor = '#444'; });

        regBtn.addEventListener('click', async () => {
            const name = input.value.trim().toUpperCase();
            if (name.length < 2) { setStatus('Enter a valid callsign', '#ff4444'); return; }
            regBtn.textContent = 'CHECKING…';
            regBtn.disabled = true;
            const avail = await UsernameManager.checkAvailable(name);
            if (!avail) {
                setStatus('Taken — try another name', '#ff4444');
                regBtn.textContent = 'REGISTER'; regBtn.disabled = false;
                isAvailable = false; return;
            }
            regBtn.textContent = 'REGISTERING…';
            const ok = await UsernameManager.register(name);
            if (ok) {
                UsernameManager.set(name);
                setStatus('✓ Callsign registered!', '#00ff88');
                regBtn.textContent = 'SUCCESS!';
                setTimeout(() => { overlay.remove(); onDone(name); }, 800);
            } else {
                // Server offline — save locally so the player can still play
                UsernameManager.set(name);
                setStatus('✓ Saved locally (server offline)', '#ffaa00');
                regBtn.textContent = 'SAVED!';
                setTimeout(() => { overlay.remove(); onDone(name); }, 800);
            }
        });

        skipBtn.addEventListener('click', () => { overlay.remove(); onDone(null); });
        setTimeout(() => input.focus(), 100);
    }
};
