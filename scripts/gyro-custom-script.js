// Gyroscope aiming for the Better xCloud Android app ("Custom script" field).
// Runs next to the official Better xCloud script (keep "Enable Better xCloud script" on).
//
// Aims by dragging on the screen, for games with their own touch UI (Fortnite...): any stick input makes those
// games switch to their controller UI. While a finger is down on the right side of the screen the gyro rides on
// that finger, so finger and gyro aim together; otherwise it drags a virtual finger.
//
// Orientation comes from gravity, not from screen.orientation, so it works however the app rotates the screen.
(() => {
    if (window.__BXG || (window.BX_EXPOSED && window.BX_EXPOSED.isGyroActive)) {
        return;
    }
    window.__BXG = 1;

    const SOURCE = 'bxGyro';
    const NOISE_DPS = 1.2;                      // slower than this = hand tremor / sensor noise
    // iOS reports accelerationIncludingGravity with the opposite sign
    const ACC_SIGN = /iP(hone|ad|od)/.test(navigator.userAgent) ? -1 : 1;

    // Positions are fractions of the video's width / height
    const POINTER_ID = 4242;
    const SWIPE_ANCHOR = [0.55, 0.45];          // where the virtual finger lands: no buttons there
    const SWIPE_MIN = [0.15, 0.08], SWIPE_MAX = [0.95, 0.85];
    const SWIPE_PER_DEG = 0.004;                // screen widths per degree at x1
    const SWIPE_ASPECT = 16 / 9;
    const SWIPE_IDLE_MS = 120;                  // lift the virtual finger after this long without movement
    const CARRIER_MIN_X = 0.45;                 // real fingers right of this carry the gyro (left = move stick)

    const SENS_LEVELS = [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 1.25, 1.5, 2, 3];
    const STORAGE_KEY = 'bxGyro2';

    const S = {
        on: false,
        want: false,                // saved choice: turn on by itself when a stream opens
        sens: 1,
        w: [0, 0, 0],               // angular velocity, device axes, deg/s
        up: [0, 0, 1],              // "up" unit vector in device axes (from the accelerometer)
        hasUp: false,
        right: [0, -1],             // device axis (x, y) that points to the right of the screen
        raf: 0,
        down: false,                // virtual finger
        px: 0, py: 0,
        rx: 0, ry: 0,               // smoothed rates
        movedAt: 0,
        tickAt: 0,
        real: new Map(),            // real fingers: pointerId -> state
    };

    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        const sens = saved.sens && typeof saved.sens === 'object' ? saved.sens.touch : saved.sens;
        SENS_LEVELS.includes(sens) && (S.sens = sens);
        S.want = saved.on === true;
    } catch (e) {}

    const save = () => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ sens: S.sens, on: S.want }));
        } catch (e) {}
    };

    const clamp = (v, min, max) => v < min ? min : (v > max ? max : v);

    /* ---------- Sensors ---------- */

    function onMotion(e) {
        const r = e.rotationRate;
        if (r && (r.alpha != null || r.beta != null || r.gamma != null)) {
            // Browsers expose the raw gyroscope as alpha = X, beta = Y, gamma = Z
            S.w = [r.alpha || 0, r.beta || 0, r.gamma || 0];
        }

        const a = e.accelerationIncludingGravity;
        if (a && (a.x != null || a.y != null || a.z != null)) {
            const x = (a.x || 0) * ACC_SIGN, y = (a.y || 0) * ACC_SIGN, z = (a.z || 0) * ACC_SIGN;
            const n = Math.hypot(x, y, z);
            if (n > 1) {
                const k = S.hasUp ? 0.2 : 1;
                S.up[0] += (x / n - S.up[0]) * k;
                S.up[1] += (y / n - S.up[1]) * k;
                S.up[2] += (z / n - S.up[2]) * k;
                if (!S.hasUp) {
                    S.hasUp = true;
                    snapRight();
                }
            }
        }
    }

    // Horizontal axis lying in the screen plane (up x screen normal), or null when the phone is almost flat
    function horizonAxis() {
        const x = S.up[1], y = -S.up[0];
        const n = Math.hypot(x, y);
        return S.hasUp && n > 0.25 ? [x / n, y / n] : null;
    }

    // Fallback for when the phone lies flat: snap the screen's "right" to the closest device axis
    function snapRight() {
        const h = horizonAxis();
        if (h) {
            S.right = Math.abs(h[0]) > Math.abs(h[1]) ? [Math.sign(h[0]), 0] : [0, Math.sign(h[1])];
        } else {
            S.right = window.innerWidth > window.innerHeight ? [0, -1] : [1, 0];
        }
    }

    // Aim rates in deg/s: turning around the real-world vertical = right, tilting around the horizon = up
    function rates() {
        const [wx, wy, wz] = S.w;
        const axis = horizonAxis() || S.right;
        const turnRight = S.hasUp
            ? -(wx * S.up[0] + wy * S.up[1] + wz * S.up[2])
            : -(wx * -S.right[1] + wy * S.right[0]);
        const tiltUp = wx * axis[0] + wy * axis[1];
        return [turnRight, tiltUp];
    }

    function isPaused() {
        // Guide / menus opened
        const settings = window.BX_STREAM_SETTINGS;
        return !!(settings && settings.xCloudPollingMode && settings.xCloudPollingMode !== 'none');
    }

    /* ---------- Fingers ---------- */

    // Real fingers reach the server through inputChannel.queuePointerInput(): hook it to see them
    function hookInputChannel() {
        const channel = window.BX_EXPOSED && window.BX_EXPOSED.inputChannel;
        if (!channel || typeof channel.queuePointerInput !== 'function') {
            return null;
        }

        if (!channel.__bxGyroQueue) {
            const orig = channel.queuePointerInput.bind(channel);
            channel.__bxGyroQueue = orig;
            channel.queuePointerInput = (timestamp, events) => {
                if (S.on && Array.isArray(events)) {
                    try {
                        events = events.map(onRealPointer);
                    } catch (e) {
                        console.warn('[bxGyro]', e);
                    }
                }
                return orig(timestamp, events);
            };
        }
        return channel.__bxGyroQueue;
    }

    function shifted(finger, type) {
        return {
            pointerId: finger.id,
            type,
            x: clamp(finger.x + finger.ox * finger.cw, 0, finger.cw),
            y: clamp(finger.y + finger.oy * finger.ch, 0, finger.ch),
            width: finger.width, height: finger.height,
            pressure: finger.pressure, twist: finger.twist,
            clientWidth: finger.cw, clientHeight: finger.ch,
        };
    }

    function onRealPointer(ev) {
        if (!ev || ev.pointerId === POINTER_ID) {
            return ev;
        }

        const $video = document.querySelector('#game-stream video');
        const cw = ev.clientWidth || ($video && $video.scrollWidth) || window.innerWidth;
        const ch = ev.clientHeight || ($video && $video.scrollHeight) || window.innerHeight;

        let finger = S.real.get(ev.pointerId);
        if (ev.type === 'pointerdown' || !finger) {
            finger = { id: ev.pointerId, carrier: ev.x / cw > CARRIER_MIN_X, ox: 0, oy: 0 };
            S.real.set(ev.pointerId, finger);
            // The real finger takes over the aiming, the game follows only one finger
            finger.carrier && liftFinger();
        }

        finger.x = ev.x;
        finger.y = ev.y;
        finger.cw = cw;
        finger.ch = ch;
        finger.width = ev.width;
        finger.height = ev.height;
        finger.pressure = ev.pressure;
        finger.twist = ev.twist;

        if (ev.type === 'pointerup') {
            S.real.delete(ev.pointerId);
        }
        return finger.carrier ? shifted(finger, ev.type) : ev;
    }

    function pointer(type) {
        const session = window.BX_EXPOSED && window.BX_EXPOSED.streamSession;
        if (!session || typeof session.onVirtualPointerInput !== 'function') {
            return;
        }

        try {
            // Same shape the touch controller uses: position relative to a 1x1 client area
            session.onVirtualPointerInput(SOURCE, performance.now(), {
                pointerId: POINTER_ID,
                type,
                x: S.px, y: S.py,
                width: 0.02, height: 0.02,
                pressure: type === 'pointerup' ? 0 : 0.5,
                twist: 0,
                clientWidth: 1, clientHeight: 1,
            });
        } catch (e) {
            console.warn('[bxGyro]', e);
        }
    }

    function liftFinger() {
        if (S.down) {
            S.down = false;
            pointer('pointerup');
        }
    }

    /* ---------- Loop ---------- */

    function tick() {
        if (!S.on) {
            S.raf = 0;
            return;
        }
        S.raf = requestAnimationFrame(tick);

        const now = performance.now();
        const dt = clamp((now - S.tickAt) / 1000, 0, 0.05);
        S.tickAt = now;

        const queue = hookInputChannel();

        let [rx, ry] = isPaused() ? [0, 0] : rates();
        S.rx += (rx - S.rx) * 0.6;
        S.ry += (ry - S.ry) * 0.6;
        rx = S.rx;
        ry = S.ry;

        if (Math.hypot(rx, ry) < NOISE_DPS) {
            S.down && now - S.movedAt > SWIPE_IDLE_MS && liftFinger();
            return;
        }
        S.movedAt = now;

        const step = SWIPE_PER_DEG * S.sens * dt;
        const dx = rx * step;
        const dy = -ry * step * SWIPE_ASPECT;

        // Fingers on the right side of the screen: add the gyro movement to them
        let carried = false;
        if (queue) {
            for (const finger of S.real.values()) {
                if (!finger.carrier) {
                    continue;
                }
                carried = true;
                finger.ox = clamp(finger.ox + dx, 0.02 - finger.x / finger.cw, 0.98 - finger.x / finger.cw);
                finger.oy = clamp(finger.oy + dy, 0.02 - finger.y / finger.ch, 0.98 - finger.y / finger.ch);
                try {
                    queue(now, [shifted(finger, 'pointermove')]);
                } catch (e) {
                    console.warn('[bxGyro]', e);
                }
            }
        }
        if (carried) {
            liftFinger();
            return;
        }

        // Nobody is touching: drag a virtual finger
        if (!S.down) {
            // Put the finger down first; start dragging on the next frame
            S.px = SWIPE_ANCHOR[0];
            S.py = SWIPE_ANCHOR[1];
            S.down = true;
            pointer('pointerdown');
            return;
        }

        S.px += dx;
        S.py += dy;
        const out = S.px < SWIPE_MIN[0] || S.px > SWIPE_MAX[0] || S.py < SWIPE_MIN[1] || S.py > SWIPE_MAX[1];
        S.px = clamp(S.px, SWIPE_MIN[0], SWIPE_MAX[0]);
        S.py = clamp(S.py, SWIPE_MIN[1], SWIPE_MAX[1]);
        pointer('pointermove');
        // Ran out of screen: lift, the next frame lands on the anchor again
        out && liftFinger();
    }

    function setEnabled(on) {
        if (on === S.on) {
            return;
        }
        S.on = on;

        if (on) {
            hookInputChannel();
            window.addEventListener('devicemotion', onMotion, { passive: true });
            S.raf || (S.raf = requestAnimationFrame(tick));
        } else {
            window.removeEventListener('devicemotion', onMotion);
            liftFinger();
            S.real.clear();
            S.w = [0, 0, 0];
            S.rx = S.ry = 0;
        }
        updateUi();
    }

    /* ---------- UI: one button in the stream menu (top-left), next to Better xCloud's own buttons ---------- */

    const ICON = "<circle cx='16' cy='16' r='13'/><ellipse cx='16' cy='16' rx='13' ry='5.5'/><ellipse cx='16' cy='16' rx='5.5' ry='13'/><circle cx='16' cy='16' r='2' fill='#fff'/>";
    const PILL_MS = 3000;

    let $btn, $pill, $pillText, pillTimer = 0, waited = 0, started = false;

    function updateUi() {
        $btn && $btn.classList.toggle('bx-stream-menu-button-on', S.on);
        $pillText && ($pillText.textContent = 'Gyro ' + (S.on ? 'ON' : 'OFF') + '  x' + S.sens);
    }

    // State + sensitivity, shown for a few seconds after a tap (or a long press) on the button
    function showPill() {
        if (!$pill) {
            const button = (text, dir) => {
                const $b = document.createElement('button');
                $b.style.cssText = 'width:44px;height:44px;border:0;border-radius:22px;color:#fff;font-size:20px;font-weight:700;background:rgba(255,255,255,.14)';
                $b.textContent = text;
                $b.onclick = () => {
                    S.sens = SENS_LEVELS[clamp(SENS_LEVELS.indexOf(S.sens) + dir, 0, SENS_LEVELS.length - 1)];
                    save();
                    showPill();
                };
                return $b;
            };

            $pill = document.createElement('div');
            $pill.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:10px;padding:4px;border-radius:26px;background:rgba(20,20,24,.9);color:#fff;font:700 13px sans-serif;white-space:pre';
            $pillText = document.createElement('span');
            $pill.append(button('-', -1), $pillText, button('+', 1));
        }

        $pill.isConnected || document.documentElement.appendChild($pill);
        updateUi();
        clearTimeout(pillTimer);
        pillTimer = setTimeout(() => $pill.remove(), PILL_MS);
    }

    function closeStreamMenu() {
        const $grip = document.querySelector('#StreamHud button[class^=GripHandle]');
        if ($grip && $grip.ariaExpanded === 'true') {
            for (let i = 0; i < 2; i++) {
                $grip.dispatchEvent(new PointerEvent('pointerdown'));
                $grip.click();
            }
        }
    }

    async function toggle() {
        if (typeof DeviceMotionEvent !== 'undefined' && DeviceMotionEvent.requestPermission) {
            await DeviceMotionEvent.requestPermission().catch(() => {});
        }
        S.want = !S.on;
        save();
        setEnabled(S.want);
        showPill();
    }

    function ensureButton() {
        const $hud = document.querySelector('#StreamHud');
        const $org = $hud && $hud.querySelector('div[class^=HUDButton]');
        if (!$org || ($btn && $hud.contains($btn))) {
            return;
        }

        // Better xCloud reorders this row when it adds its buttons: let it finish first
        const $parent = $org.parentElement;
        const $bx = $parent.querySelector('button[title="Better xCloud"]');
        if (!$bx && ++waited < 4) {
            return;
        }

        if (!$btn) {
            const $new = (($bx && $bx.closest('div[class^=HUDButton]')) || $org).cloneNode(true);
            const $button = $new.querySelector('button');
            const $svg = $new.querySelector('svg');
            if (!$button || !$svg) {
                return;
            }

            $new.style.pointerEvents = '';
            $new.classList.remove('bx-stream-menu-button-on');
            $button.title = 'Gyro';
            for (const [k, v] of [['viewBox', '0 0 32 32'], ['fill', 'none'], ['stroke', '#fff'], ['stroke-width', '2'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round']]) {
                $svg.setAttribute(k, v);
            }
            $svg.style.fill = 'none';
            $svg.innerHTML = ICON;

            $new.addEventListener('click', e => {
                e.preventDefault();
                closeStreamMenu();
                toggle();
            });
            $new.addEventListener('contextmenu', e => {
                e.preventDefault();
                showPill();
            });
            $btn = $new;
        }

        $parent.appendChild($btn);
        updateUi();
    }

    setInterval(() => {
        if (document.querySelector('#game-stream video')) {
            // Saved choice: comes back on by itself, once per stream
            if (!started) {
                started = true;
                S.want && setEnabled(true);
            }
            ensureButton();
        } else if (started) {
            started = false;
            waited = 0;
            setEnabled(false);
            clearTimeout(pillTimer);
            $pill && $pill.remove();
        }
    }, 1000);
})();
