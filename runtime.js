/* Parallel Tavern 0.5.13 — Tavern Helper global script.
 * No external dependencies, new API keys, custom generation or chat-file writes.
 * Each mounted same-origin document keeps its own native SillyTavern pipeline.
 */
(function parallelTavernBootstrap() {
    'use strict';
    const KEY = '__PARALLEL_TAVERN_V2__';
    try { if (window.__PT_CHILD_ID__ || window.parent.__PT_CHILD_ID__ || window.frameElement?.dataset.ptSessionId) return; } catch {}
    const startupTiming = { scriptStartedAt: Date.now(), hostPageAgeAtStartMs: null, hostFoundMs: null, launcherReadyMs: null };
    let pendingEntry;
    const owner = `helper-${Date.now()}-${Math.random()}`;
    let host;
    let retry;
    let stopped = false;
    function resolveHost() {
        let candidate = window;
        while (true) {
            if (candidate.__PT_CHILD_ID__) return null;
            if (candidate.document.getElementById('send_textarea')) {
                startupTiming.hostFoundMs ??= Date.now() - startupTiming.scriptStartedAt;
                startupTiming.hostPageAgeAtStartMs ??= Math.round(startupTiming.scriptStartedAt - candidate.performance.timeOrigin);
                if (!candidate.SillyTavern?.getContext) {
                    if (!pendingEntry && candidate.document.body && !candidate.document.getElementById('pt-launcher')) {
                        pendingEntry = candidate.document.createElement('button');
                        pendingEntry.textContent = '并行 · 正在连接…';
                        pendingEntry.style.cssText = 'position:fixed!important;right:18px!important;bottom:24px!important;z-index:2147483647!important;padding:12px 18px!important;border:1px solid #e4dcd7!important;border-radius:28px!important;background:#faf7f3!important;color:#66585d!important;font:14px sans-serif!important';
                        pendingEntry.onclick = () => start(true);
                        candidate.document.body.append(pendingEntry);
                    }
                    return null;
                }
                return candidate;
            }
            if (candidate.parent === candidate) return null;
            candidate = candidate.parent;
        }
    }
    function report(error) {
        console.error('[Parallel Tavern startup]', error);
        let target = host;
        try { target ||= window.parent; } catch { target = window; }
        const message = `并行对话 v0.5.13 启动失败：${String(error?.message || error).slice(0, 350)}`;
        try {
            const d = target.document;
            d.getElementById('pt-startup-error')?.remove();
            const box = d.createElement('div'); box.id = 'pt-startup-error';
            box.style.cssText = 'display:block!important;position:fixed!important;top:15%!important;left:5%!important;width:90%!important;z-index:2147483647!important;background:#321f28!important;color:white!important;padding:20px!important;border:2px solid #e99!important;white-space:pre-wrap!important;font:16px/1.5 sans-serif!important';
            box.textContent = message + '\n请把这段错误文字发给我。点击此提示可关闭。';
            box.onclick = () => box.remove(); d.body.append(box);
        } catch { try { target.alert(message); } catch {} }
    }
    function start(show = false) {
        if (stopped) return;
        try {
            host = resolveHost();
            if (!host) {
                if (show) report('没有找到主聊天页面。请先打开一个角色，再点脚本按钮。');
                return false;
            }
            // Opening UI never aborts or waits for the native main generation.
            // v0.1.0–2 used a shared version/owner guard that incorrectly blocked it.
            const legacy = host.__PARALLEL_TAVERN_V1__;
            if (legacy && !host[KEY]) {
                const oldState = legacy.diagnostics?.();
                if (oldState?.sessions?.length > 1) {
                    legacy.show?.();
                    return true; // Keep existing child contexts alive, never destroy streams.
                }
                legacy.requestDispose?.();
                for (const id of ['pt-launcher','pt-shell','pt-panel','pt-picker','pt-toast','pt-startup-error']) {
                    host.document.getElementById(id)?.remove();
                }
            }
            const existing = host[KEY];
            if (existing && existing.owner !== owner) {
                const state = existing.diagnostics();
                if (state.sessions.length === 1) existing.dispose();
                else { existing.show(); return true; }
            }
            if (!host[KEY]) install(host);
            pendingEntry?.remove(); pendingEntry = null;
            startupTiming.launcherReadyMs ??= Date.now() - startupTiming.scriptStartedAt;
            host[KEY].claim?.(owner);
            if (show) host[KEY].show();
            host.document.getElementById('pt-startup-error')?.remove();
            return true;
        } catch (error) { report(error); return false; }
    }
    // Register the button before any initialization or existing-instance checks.
    // Helper reruns must re-bind their own button even when a controller exists.
    try {
        if (typeof window.getButtonEvent === 'function' && typeof window.eventOn === 'function') {
            window.eventOn(window.getButtonEvent('并行对话'), () => start(true));
        }
    } catch (error) { report(error); }
    let attempts = 0;
    if (!start()) {
        retry = window.setInterval(() => {
            if (start() || ++attempts >= 120) {
                window.clearInterval(retry);
                if (!host && !stopped && attempts >= 120) report('等待主聊天页面超时。请打开角色后点击“并行对话”。');
            }
        }, 500);
    }
    window.addEventListener('pagehide', () => {
        stopped = true; window.clearInterval(retry); pendingEntry?.remove();
        if (host?.[KEY]?.owner === owner) host[KEY].requestDispose();
    }, { once: true });

    function install(host) {
    const doc = host.document;
    let launcherVisible = host.__PT_EXTENSION_CONFIG__?.showLauncher !== false;
    const VERSION = '0.5.13';
    const iosBrowser = /iPhone|iPad|iPod/.test(host.navigator.userAgent) || (host.navigator.platform === 'MacIntel' && host.navigator.maxTouchPoints > 1);
    let hostAppVersion = null;
    let cleanupErrors = 0;
    function runCleanups(callbacks) {
        for (const clean of callbacks.splice(0)) {
            try {
                const result = clean();
                if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => { cleanupErrors++; });
            } catch { cleanupErrors++; }
        }
    }
    if (typeof host.__TAURI__?.app?.getVersion === 'function') {
        Promise.resolve().then(() => host.__TAURI__.app.getVersion()).then(value => {
            if (typeof value === 'string' && /^[\w.+-]{1,64}$/.test(value)) hostAppVersion = value;
        }).catch(() => {});
    }
    let previousPageStage = null;
    let currentPageStage = null;
    const pageStages = [];
    const mainErrors = { runtime: 0, unhandledRejection: 0, recent: [] };
    const diagnosticPageId = `page-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const diagnosticStorage = { sessionWrite: 'not-attempted', backupWrite: 'not-attempted', backupRead: 'missing' };
    const backupKey = 'parallel-tavern.last-parallel-diagnostic';
    let lastParallelPageStage = null;
    try {
        const raw = host.localStorage.getItem(backupKey);
        if (raw && raw.length <= 32768) {
            const candidate = JSON.parse(raw);
            const age = Date.now() - candidate.time;
            if (candidate.sessions > 1 && Number.isFinite(age) && age >= 0 && age <= 86400000) {
                lastParallelPageStage = candidate; diagnosticStorage.backupRead = 'ok';
            } else diagnosticStorage.backupRead = 'expired-or-invalid';
        } else if (raw) diagnosticStorage.backupRead = 'oversized';
    } catch { diagnosticStorage.backupRead = 'error'; }
    function persistStage() {
        let serialized;
        try { serialized = JSON.stringify(currentPageStage); } catch { diagnosticStorage.sessionWrite = 'serialization-error'; return; }
        if (serialized.length > 32768) { diagnosticStorage.sessionWrite = 'oversized'; return; }
        try { host.sessionStorage.setItem('parallel-tavern.last-stage', serialized); diagnosticStorage.sessionWrite = 'ok'; }
        catch { diagnosticStorage.sessionWrite = 'error'; }
        // Keep the last multi-session state when startup creates a new main-only page.
        // This is an origin-wide backup, NOT proof that the same tab crashed.
        if (currentPageStage.sessions > 1) {
            try { host.localStorage.setItem(backupKey, serialized); diagnosticStorage.backupWrite = 'ok'; }
            catch { diagnosticStorage.backupWrite = 'error'; }
        }
    }
    try { previousPageStage = JSON.parse(host.sessionStorage.getItem('parallel-tavern.last-stage') || 'null'); } catch {}
    function recordPageStage(stage) {
        const entry = { stage, time: Date.now(), sessions: sessions.size };
        pageStages.push(entry);
        if (pageStages.length > 16) pageStages.shift();
        currentPageStage = { ...currentPageStage, version: VERSION, pageId: diagnosticPageId, ...entry, visibility: doc.visibilityState, cleanupErrors, mainErrors: { ...mainErrors }, recentStages: [...pageStages] };
        if (stage === '副窗口就绪' || stage === '关闭副窗口' || stage.startsWith('副窗口就绪后') || stage === '副窗口扩展加载完成' || stage === '副窗口执行错误' || stage === '主页面执行错误' || stage === '页面转入后台') {
            currentPageStage.resources = [...sessions.values()].map(session => {
                try {
                    const w = session.win, d = w?.document;
                    return { main: session.id === 'main', ready: !!session.ready,
                        iframes: d?.getElementsByTagName('iframe').length ?? null,
                        images: d?.images.length ?? null, scripts: d?.scripts.length ?? null,
                        nativeListeners: w?.__PT_BOOT_TRACE__?.bridgeEvents?.active ?? null,
                        extensionsLoaded: !!session.extensionsLoaded, errors: session.issues?.length || 0,
                        loading: bootSnapshot(w),
                        recentIssues: (session.issues || []).slice(-3),
                        reducedCompositing: !!d?.getElementById('pt-ios-compositing') };
                } catch { return { main: session.id === 'main', accessible: false }; }
            });
        }
        persistStage();
    }
    function bootSnapshot(w) {
        const t = w?.__PT_BOOT_TRACE__;
        if (!t) return null;
        return { sampledAt: Date.now(), nativeCalls: t.nativeCalls ? JSON.parse(JSON.stringify(t.nativeCalls)) : null,
            bridgeBytes: t.bridgeBytes ? { ...t.bridgeBytes } : null,
            resourceErrors: { ...t.resourceErrors },
            trackedPendingRequests: t.requests.filter(r => r.state === 'pending').length,
            recentRequests: t.requests.slice(-12).map(r => ({ route: r.route, state: r.state, status: r.status ?? null,
                elapsedMs: r.elapsedMs ?? Date.now() - r.started })),
            mainThread: t.mainThread ? { ...t.mainThread } : null };
    }
    const MAX_SESSIONS = 3;
    const sessions = new Map();
    recordPageStage('启动扩展');
    const recentChatTimes = new Map();
    const teardown = [];
    function mainErrorDetail(error, file, line, column, source) {
        try {
            const basename = value => { try { const name = new URL(String(value).slice(0, 2048), host.location.href).pathname.split('/').pop(); return /^[\w.-]{1,100}\.(?:m?js|html)$/.test(name) ? name : '(inline)'; } catch { return '(unknown)'; } };
            const frames = [...String(error?.stack || '').slice(0, 6000).matchAll(/((?:https?|tauri|asset):\/\/[^\s)]+?):(\d+):(\d+)/g)].slice(0, 3).map(m => ({ file: basename(m[1]), line: Number(m[2]), column: Number(m[3]) }));
            return { source, name: ['Error','TypeError','ReferenceError','SyntaxError','RangeError','URIError','EvalError','AggregateError'].includes(error?.name) ? error.name : 'Error',
                file: file ? basename(file) : null, line: Number(line) || null, column: Number(column) || null, frames };
        } catch { return { source, name: 'Error' }; }
    }
    const rememberMainError = detail => { mainErrors.recent = [...mainErrors.recent.slice(-2), detail]; };
    const mainError = e => {
        if (e.target !== host) return;
        mainErrors.runtime++; rememberMainError(mainErrorDetail(e.error, e.filename, e.lineno, e.colno, 'runtime'));
        if (mainErrors.runtime <= 3) recordPageStage('主页面执行错误');
    };
    const mainRejection = e => {
        mainErrors.unhandledRejection++; rememberMainError(mainErrorDetail(e.reason, null, null, null, 'unhandled-rejection'));
        if (mainErrors.unhandledRejection <= 3) recordPageStage('主页面执行错误');
    };
    host.addEventListener('error', mainError, true);
    host.addEventListener('unhandledrejection', mainRejection);
    teardown.push(() => { host.removeEventListener('error', mainError, true); host.removeEventListener('unhandledrejection', mainRejection); });
    // Restrict this reversible workaround to iOS documents owned by this controller.
    // Do not hide/suspend the native chat: background streaming still needs its DOM.
    const iosCompositingCSS = `html:root, html:root *, html:root *::before, html:root *::after, html:root ::backdrop {
        -webkit-backdrop-filter: none !important; backdrop-filter: none !important;
    }`;
    let mainCompositingStyle = null;
    function syncIOSCompositing() {
        if (!iosBrowser) return;
        if ([...sessions.values()].some(s => s.id !== 'main' && !s.error)) {
            if (!mainCompositingStyle) {
                mainCompositingStyle = doc.createElement('style');
                mainCompositingStyle.id = 'pt-ios-compositing';
                mainCompositingStyle.textContent = iosCompositingCSS;
                doc.head.append(mainCompositingStyle);
            }
        } else {
            mainCompositingStyle?.remove(); mainCompositingStyle = null;
        }
    }
    teardown.push(() => { mainCompositingStyle?.remove(); mainCompositingStyle = null; });
    const soundKey = 'parallel-tavern.completion-sound';
    let nightMode = false;
    try { nightMode = host.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch {}
    let soundEnabled = true;
    try { soundEnabled = host.localStorage.getItem(soundKey) !== 'off'; } catch {}
    let audioContext = null;
    const sounding = new Set();
    function unlockSound() {
        if (!soundEnabled || disposed) return;
        try {
            const Audio = host.AudioContext || host.webkitAudioContext;
            if (!Audio) return;
            audioContext ||= new Audio();
            if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
        } catch { /* Audio restrictions must not interrupt chat. */ }
    }
    function completionSound() {
        // Never queue a delayed chime: a later user gesture must not replay old completions.
        if (!soundEnabled || disposed || audioContext?.state !== 'running') return;
        try {
            const start = audioContext.currentTime;
            const gain = audioContext.createGain(); gain.connect(audioContext.destination);
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(0.10, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.6);
            const tone = audioContext.createOscillator(); tone.type = 'sine';
            tone.frequency.setValueAtTime(660, start); tone.frequency.setValueAtTime(880, start + 0.16);
            tone.connect(gain); sounding.add(tone);
            tone.onended = () => { sounding.delete(tone); tone.disconnect(); gain.disconnect(); };
            tone.start(start); tone.stop(start + 0.65);
        } catch { /* A missing output device does not affect generation. */ }
    }
    function bindAudioGesture(w) {
        w.addEventListener('pointerdown', unlockSound, true);
        w.addEventListener('keydown', unlockSound, true);
        return () => { w.removeEventListener('pointerdown', unlockSound, true); w.removeEventListener('keydown', unlockSound, true); };
    }
    teardown.push(bindAudioGesture(host), () => {
        for (const tone of sounding) { try { tone.stop(); } catch {} }
        if (audioContext) void audioContext.close().catch(() => {});
    });
    let enabled = false;
    let activeId = 'main';
    let disposed = false;
    let panelOpen = false;
    let pickerOpen = false;
    let menuOpen = false;
    let controlsId = null;
    let launcherSignature = '';
    let badgeSignature = '';
    let appHTML = null;
    let renderPending = false;
    let pointerActive = false;
    let lastAction = null;
    let toastTimer;
    let appReady = false;
    let disposeRequested = false;
    const ctx = w => w.SillyTavern.getContext();
    const element = (tag, className, text) => {
        const e = doc.createElement(tag);
        if (className) e.className = className;
        if (text !== undefined) e.textContent = text;
        return e;
    };
    const button = (text, fn, label = text) => {
        const b = element('button', 'pt-button', text);
        b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
        b.addEventListener('click', fn);
        return b;
    };
    const shortError = error => String(error?.message || error || '未知错误').slice(0, 240);
    function iconButton(label, name, action) {
        const b = button('', action, label); b.classList.add('pt-icon-button');
        const paths = { plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', more: 'M5 12h.01M12 12h.01M19 12h.01', arrow: 'M5 12h14M13 6l6 6-6 6' };
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'pt-icon'); svg.setAttribute('aria-hidden', 'true');
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.more);
        svg.append(path); b.append(svg); return b;
    }
    function portrait(session) {
        const face = element('span', 'pt-portrait', [...(session.title || '聊')][0]);
        face.setAttribute('aria-hidden', 'true');
        try {
            const url = session.avatar && ctx(host).getThumbnailUrl?.('avatar', session.avatar);
            if (url) {
                const img = doc.createElement('img'); img.alt = ''; img.src = url;
                img.addEventListener('error', () => img.remove(), { once: true }); face.append(img);
            }
        } catch { /* Initials remain available before host thumbnails are ready. */ }
        return face;
    }
    const main = { id: 'main', win: host, ready: true, busy: false, status: '待命', title: '主页面', avatar: null, cleanups: [] };
    sessions.set('main', main);

    const style = element('style');
    style.textContent = `
#pt-shell{position:fixed;inset:0;z-index:2147482999;pointer-events:none}
#pt-shell .pt-frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#171b22;pointer-events:auto}
#pt-shell .pt-frame.pt-hidden{visibility:hidden;pointer-events:none}
#pt-panel,#pt-picker,#pt-launcher,#pt-toast{box-sizing:border-box;font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#35312f;text-shadow:none;letter-spacing:normal}
#pt-panel *,#pt-launcher *{box-sizing:border-box;text-shadow:none}
#pt-panel{position:fixed;z-index:2147483002;inset:auto 18px calc(158px + env(safe-area-inset-bottom,0px)) auto;width:min(364px,calc(100vw - 24px));max-height:70vh;max-height:70dvh;overflow:auto;overscroll-behavior:contain;margin:0;padding:0;background:#fcfbf9;border:1px solid #fff;border-radius:26px;box-shadow:0 20px 70px #29232926,0 2px 8px #2923290a;scrollbar-width:thin;scrollbar-color:#d6cfcc transparent}
#pt-panel[hidden],#pt-picker[hidden],#pt-toast[hidden]{display:none!important}
#pt-panel .pt-row{display:flex;align-items:center;gap:8px;padding:22px 20px 15px;margin:0}
#pt-panel .pt-heading{display:block;flex:1;min-width:0;cursor:move;touch-action:none;user-select:none;font:italic 30px/1.1 Georgia,"Times New Roman",serif;letter-spacing:-1px;color:#322f31}
#pt-panel .pt-subheading{display:block;font:10px/1.5 system-ui,sans-serif;letter-spacing:2px;color:#8c8587;margin-top:7px}
#pt-panel .pt-button{font:12px/1.4 system-ui,-apple-system,"Microsoft YaHei",sans-serif;box-shadow:none;text-shadow:none;min-height:40px;min-width:40px;padding:9px 13px;margin:0;border:0;border-radius:12px;background:#f0ece9;color:#615856;cursor:pointer;touch-action:manipulation;transition:background .15s}
#pt-panel .pt-button:hover{background:#e9e2df;color:#332b2a}
#pt-panel .pt-button:disabled{opacity:.4;cursor:default}
#pt-panel .pt-button:focus-visible,#pt-panel summary:focus-visible,#pt-launcher:focus-visible{outline:2px solid #ad7777;outline-offset:2px}
#pt-panel .pt-icon-button{display:grid;place-items:center;flex-shrink:0;width:40px;height:40px;padding:0;background:transparent;border-radius:50%}
.pt-icon{display:block;width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
#pt-panel .pt-add{background:#353034;color:#fff}
#pt-panel .pt-add:hover{background:#554b52;color:#fff}
#pt-panel .pt-overview{display:flex;gap:14px;margin:0 20px 17px;font-size:11px;color:#8a8181;align-items:center}
#pt-panel .pt-overview span{display:flex;align-items:center;gap:5px}
#pt-panel .pt-overview .pt-live-count::before{content:'';width:5px;height:5px;border-radius:50%;background:#aa879c}
#pt-panel .pt-overview .pt-ready-count{color:#b16f68}
#pt-panel .pt-section-label{display:flex;justify-content:space-between;border-top:1px solid #eee9e7;padding:14px 20px 5px;font-size:10px;letter-spacing:1.5px;color:#9b9294}
#pt-panel .pt-session-list{padding:0 8px 10px}
#pt-panel .pt-card{position:relative;margin:0;border:0;padding:0;border-radius:15px;background:transparent}
#pt-panel .pt-card+.pt-card{margin-top:3px}
#pt-panel .pt-card.pt-active{background:#f1ecea}
#pt-panel .pt-session-row{display:flex;align-items:center;min-width:0}
#pt-panel .pt-session-open{display:flex;align-items:center;text-align:left;gap:12px;flex:1;min-width:0;padding:15px 5px 15px 12px;background:transparent;border-radius:15px;min-height:96px;white-space:normal}
#pt-panel .pt-session-open:hover{background:#eae3e550}
.pt-portrait{position:relative;display:grid;place-items:center;flex-shrink:0;width:49px;height:49px;border-radius:50%;background:#e8e0de;color:#88726e;font:20px Georgia,serif;isolation:isolate}
.pt-portrait img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;border:0;margin:0}
#pt-panel .pt-card:nth-child(even) .pt-portrait{background:#e7e2ec;color:#8a779c}
#pt-panel .pt-card[data-busy="true"] .pt-portrait::after{content:'';position:absolute;inset:-4px;border:1.5px dashed #b39eaf;border-radius:50%;animation:pt-orbit 12s linear infinite;pointer-events:none}
#pt-panel .pt-card[data-unread="true"] .pt-portrait::after{content:'';position:absolute;inset:-4px;border:2px solid #c99084;border-radius:50%;pointer-events:none}
#pt-panel .pt-session-copy{display:block;min-width:0;flex:1}
#pt-panel .pt-title{display:flex;gap:6px;align-items:center;margin:0;font-size:13px;font-weight:600;line-height:1.5;color:#393235}
#pt-panel .pt-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
#pt-panel .pt-current{font-size:9px;font-weight:400;color:#9e9093;white-space:nowrap}
#pt-panel .pt-completed{font-size:9px;font-weight:500;white-space:nowrap;color:#ae6c61}
#pt-panel .pt-preview{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a09394;font-size:11px;line-height:1.7;margin:3px 0}
#pt-panel .pt-status{display:block;font-size:10px;font-weight:400;line-height:1.5;color:#9b8e92}
#pt-panel .pt-card[data-busy="true"] .pt-status{color:#9c7d99}
#pt-panel .pt-card[data-unread="true"] .pt-status{color:#b5756b}
#pt-panel .pt-session-row>.pt-icon-button{margin-right:5px;color:#aca0a4}
#pt-panel .pt-actions{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 12px 73px}
#pt-panel .pt-actions .pt-button{font-size:11px;min-height:36px;padding:7px 10px}
#pt-panel .pt-error{font-size:11px;color:#a45758;padding:0 12px 10px;margin:0;overflow-wrap:anywhere}
#pt-panel .pt-footer{position:sticky;bottom:0;z-index:2;background:#fcfbf9;display:flex;align-items:center;justify-content:space-between;padding:10px 16px 12px;border-top:1px solid #eee9e7;color:#a19598;font-size:10px}
#pt-panel .pt-footer .pt-button{background:transparent;color:#8c7c83;font-size:11px;padding:8px;min-height:36px}
#pt-panel .pt-menu{margin:0 15px 12px;padding:12px;background:#f2edeb;border-radius:14px;display:flex;gap:6px;flex-wrap:wrap}
#pt-panel .pt-menu .pt-button{background:#fffcfa;font-size:11px;flex:1}
#pt-panel .pt-menu .pt-exit{flex-basis:100%;background:transparent;color:#aa7370}
#pt-panel .pt-muted{font-size:11px;line-height:1.7;color:#93868c;margin:8px 0}
#pt-panel .pt-welcome{padding:0 22px 24px}
#pt-panel .pt-welcome .pt-button{margin-top:10px;background:#3b343a;color:white;width:100%}
#pt-panel #pt-picker{position:static;margin:0;padding:0;background:transparent;width:100%;border:0}
#pt-panel #pt-picker .pt-heading{font:600 18px/1.4 system-ui,sans-serif;letter-spacing:0}
#pt-search{display:block;width:calc(100% - 40px);margin:0 20px 12px;padding:12px 14px;border:1px solid #e8e0df;border-radius:13px;background:#f5f0ee;color:#54454d;font:13px/1.5 system-ui;box-sizing:border-box}
#pt-search::placeholder{color:#a6979d}
#pt-character-list{padding:0 12px 16px}
#pt-character-list .pt-button{display:block;width:100%;background:transparent;text-align:left;margin:3px 0;overflow-wrap:anywhere}
#pt-picker>.pt-muted,#pt-picker>textarea,#pt-picker>.pt-button{margin:10px 20px;max-width:calc(100% - 40px)}
#pt-launcher{position:fixed;z-index:2147483001;inset:auto 18px calc(88px + env(safe-area-inset-bottom,0px)) auto;margin:0;min-width:64px;min-height:56px;padding:8px 13px 8px 8px;border-radius:28px;border:1px solid #fff;background:#fcf9f5;box-shadow:0 5px 25px #37293224;color:#594b52;cursor:pointer;touch-action:none}
#pt-launcher .pt-dock{display:flex;align-items:center;gap:10px;pointer-events:none}
#pt-launcher .pt-dock-faces{display:flex;padding-left:4px}
#pt-launcher .pt-portrait{width:32px;height:32px;font-size:13px;border:2px solid #fcf9f5;margin-left:-4px}
#pt-launcher .pt-dock-label{display:block;font-size:11px;line-height:1.5;font-weight:600;text-align:left}
#pt-launcher .pt-dock-note{display:block;font-size:9px;color:#a4949b;font-weight:400}
#pt-completion-badge{position:fixed;inset:0 auto auto 0;margin:0;width:0;height:0;min-width:0;min-height:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483004}
#pt-completion-badge .pt-avatar-badge{position:fixed;box-sizing:border-box;width:16px;height:16px;padding:0;border:1.5px solid #fcf9f5;border-radius:50%;background:#c28880;color:white;font:600 9px/13px system-ui;text-align:center;pointer-events:none;box-shadow:0 1px 3px #37293218}
#pt-completion-badge[data-night="true"] .pt-avatar-badge{border-color:#242126;background:#ba7e94;color:#fff}
#pt-completion-badge[hidden]{display:none!important}
#pt-toast{pointer-events:none;position:fixed;inset:auto auto calc(20px + env(safe-area-inset-bottom,0px)) 50%;transform:translateX(-50%);z-index:2147483003;width:max-content;max-width:calc(100vw - 32px);margin:0;padding:12px 16px;border:1px solid #fff;border-radius:14px;background:#faf4f1;color:#805f6c;box-shadow:0 4px 20px #39283020;font-size:12px;white-space:pre-wrap}
@keyframes pt-orbit{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){#pt-panel .pt-card .pt-portrait::after{animation:none}}
@media(max-width:600px){#pt-panel{right:12px;width:min(364px,calc(100vw - 24px));max-height:70dvh}#pt-launcher{right:12px}#pt-panel .pt-session-row>.pt-icon-button{width:44px;height:44px}#pt-panel .pt-actions .pt-button{min-height:42px}}

#pt-panel .pt-chat-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#796b75;margin-top:3px}
#pt-panel .pt-character-choice{display:flex;gap:8px;align-items:center;border-bottom:1px solid #eee9e7}
#pt-panel #pt-character-list .pt-character-choice>.pt-button:first-child{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
#pt-panel .pt-character-choice .pt-portrait{width:40px;height:40px;font-size:18px}
#pt-panel .pt-character-copy{min-width:0;flex:1;white-space:normal;overflow-wrap:anywhere}
#pt-panel #pt-character-list .pt-character-choice>.pt-button:last-child{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:auto;min-height:44px;padding:10px 12px;border:1px solid #d7bec9;border-radius:13px;background:#efe3e8;color:#654956;font-size:12px;font-weight:600;white-space:nowrap;flex-shrink:0}
#pt-panel #pt-character-list .pt-character-choice>.pt-button:last-child:hover{background:#e5d2dc;border-color:#b993a5}
#pt-panel #pt-character-list .pt-character-choice>.pt-button:last-child:focus-visible{outline:2px solid #9b6882;outline-offset:2px}
#pt-panel #pt-character-list .pt-character-choice>.pt-button:last-child:active{background:#dbc3ce}
#pt-panel .pt-history-arrow{font-size:16px;line-height:1;font-weight:400}
#pt-panel .pt-character-choice .pt-muted{display:block;margin:3px 0 0}
#pt-history-list{padding:0 20px 18px}
#pt-panel #pt-history-list .pt-button{display:block;text-align:left;width:100%;margin:6px 0;background:#f2edeb;white-space:normal;overflow-wrap:anywhere}
#pt-panel .pt-history-name,#pt-panel #pt-history-list .pt-muted{display:block}
#pt-panel .pt-menu details{width:100%;font-size:12px;padding:8px}
#pt-panel .pt-menu summary{cursor:pointer;min-height:32px}
    `;
    doc.head.append(style);
    const shell = element('div'); shell.id = 'pt-shell'; shell.dataset.ttMobileSurface = 'none';
    const launcher = button('并行', event => {
        recordPageStage('点击悬浮入口');
        if (enabled && host.__PT_EXTENSION_CONFIG__?.avatarQuickSwitch === true && event.detail > 0) {
            // Pointer capture for dragging retargets clicks to the launcher.
            // Hit-test visible avatars; reverse order respects overlapping faces.
            const face = [...launcher.querySelectorAll('[data-pt-session]')].reverse().find(node => {
                const r = node.getBoundingClientRect();
                return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
            });
            if (face) { setActive(face.dataset.ptSession); return; }
        }
        panelOpen = !panelOpen; pickerOpen = false; render();
    });
    launcher.id = 'pt-launcher'; launcher.dataset.ttMobileSurface = 'free-window';
    const completionBadge = element('span'); completionBadge.id = 'pt-completion-badge'; completionBadge.hidden = true; completionBadge.setAttribute('aria-hidden', 'true');
    const panel = element('section'); panel.id = 'pt-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', '并行角色会话'); panel.dataset.ttMobileSurface = 'free-window';
    const picker = element('section'); picker.id = 'pt-picker'; picker.hidden = true;
    picker.setAttribute('aria-label', '选择并行角色'); picker.dataset.ttMobileSurface = 'free-window';
    const toast = element('div'); toast.id = 'pt-toast'; toast.hidden = true; toast.setAttribute('role', 'status');
    style.textContent += "\n#pt-panel[data-night=\"true\"],#pt-launcher[data-night=\"true\"],#pt-toast[data-night=\"true\"]{color-scheme:dark;background:#242126;border-color:#494149;color:#eee7eb;box-shadow:0 12px 40px #0005;scrollbar-color:#655762 transparent}\n#pt-panel[data-night=\"true\"] .pt-heading,#pt-panel[data-night=\"true\"] .pt-title{color:#f2e9ee}\n#pt-panel[data-night=\"true\"] .pt-button{background:#3b333b;color:#ede1e7}\n#pt-panel[data-night=\"true\"] .pt-button:hover{background:#51434f;color:#fff}\n#pt-panel[data-night=\"true\"] .pt-add,#pt-panel[data-night=\"true\"] .pt-welcome .pt-button{background:#d2b5c5;color:#281f26}\n#pt-panel[data-night=\"true\"] .pt-card.pt-active,#pt-panel[data-night=\"true\"] .pt-menu{background:#302a31}\n#pt-panel[data-night=\"true\"] .pt-session-open,#pt-panel[data-night=\"true\"] .pt-icon-button,#pt-panel[data-night=\"true\"] #pt-character-list .pt-button{background:transparent}\n#pt-panel[data-night=\"true\"] .pt-session-open:hover{background:#433743}\n#pt-panel[data-night=\"true\"] .pt-footer{background:#242126;border-color:#494149;color:#c2b2bc}\n#pt-panel[data-night=\"true\"] .pt-section-label,#pt-panel[data-night=\"true\"] .pt-character-choice{border-color:#494149;color:#bfb0bb}\n#pt-panel[data-night=\"true\"] :is(.pt-subheading,.pt-overview,.pt-current,.pt-preview,.pt-status,.pt-muted,.pt-chat-name),#pt-launcher[data-night=\"true\"] .pt-dock-note{color:#c2b0bb}\n#pt-panel[data-night=\"true\"] :is(.pt-completed,.pt-ready-count),#pt-panel[data-night=\"true\"] .pt-card[data-unread=\"true\"] .pt-status{color:#edb1a4}\n#pt-panel[data-night=\"true\"] .pt-card[data-busy=\"true\"] .pt-status{color:#d2acd1}\n#pt-panel[data-night=\"true\"] .pt-error{color:#ffb3b3}\n#pt-panel[data-night=\"true\"] .pt-portrait,#pt-launcher[data-night=\"true\"] .pt-portrait{background:#51424c;color:#efcadc;border-color:#242126}\n#pt-panel[data-night=\"true\"] #pt-search,#pt-panel[data-night=\"true\"] #pt-diagnostic-text{background:#302a31!important;color:#ede1e7!important;border-color:#675561!important;color-scheme:dark}\n#pt-panel[data-night=\"true\"] #pt-search::placeholder{color:#bcaab5}\n#pt-panel[data-night=\"true\"] #pt-history-list .pt-button{background:#38303a;color:#eee4eb}\n#pt-panel[data-night=\"true\"] #pt-character-list .pt-character-choice>.pt-button:last-child{background:#493843;border-color:#806372;color:#f3dce7}\n#pt-panel[data-night=\"true\"] .pt-footer .pt-button{color:#d0bec9}\n\n";
    doc.body.append(shell, launcher, panel, toast, completionBadge);
    const safeArea = element('div');
    safeArea.dataset.ttMobileSurface = 'none';
    safeArea.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    doc.body.append(safeArea); teardown.push(() => safeArea.remove());
    function floatingBounds() {
        const v = host.visualViewport, css = host.getComputedStyle(safeArea), root = host.getComputedStyle(doc.documentElement);
        const usable = n => Number.isFinite(n) && n >= 80;
        const vw = usable(v?.width) ? v.width : (host.innerWidth || doc.documentElement.clientWidth || 360);
        const vh = usable(v?.height) ? v.height : (host.innerHeight || doc.documentElement.clientHeight || 640);
        const x = usable(v?.width) && Number.isFinite(v.offsetLeft) ? v.offsetLeft : 0;
        const y = usable(v?.height) && Number.isFinite(v.offsetTop) ? v.offsetTop : 0;
        const inset = (side, padding, limit) => Math.min(limit / 4, Math.max(0, parseFloat(root.getPropertyValue(`--tt-inset-${side}`)) || parseFloat(padding) || 0));
        return { left: x + inset('left', css.paddingLeft, vw) + 12,
            top: y + inset('top', css.paddingTop, vh) + 12,
            right: x + vw - inset('right', css.paddingRight, vw) - 12,
            bottom: y + vh - inset('bottom', css.paddingBottom, vh) - 12 };
    }
    function positionCompletionBadge() {
        if (completionBadge.hidden) return;
        const viewport = host.visualViewport;
        const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
        const width = viewport?.width || host.innerWidth, height = viewport?.height || host.innerHeight;
        const faces = [...launcher.querySelectorAll('[data-pt-session]')];
        for (const badge of completionBadge.children) {
            const face = faces.find(node => node.dataset.ptSession === badge.dataset.ptSession);
            badge.hidden = !face;
            if (!face) continue;
            const r = face.getBoundingClientRect();
            badge.style.setProperty('left', `${Math.max(left + 2, Math.min(left + width - 18, r.right - 8))}px`, 'important');
            badge.style.setProperty('top', `${Math.max(top + 2, Math.min(top + height - 18, r.top - 5))}px`, 'important');
        }
    }
    // TT can give generic floating containers a zero/auto height. Do not resolve
    // a frame's height through a percentage of that container: size both explicitly.
    function layoutSessions() {
        const viewport = host.visualViewport;
        const width = Math.round(viewport?.width || host.innerWidth || doc.documentElement.clientWidth);
        const height = Math.round(viewport?.height || host.innerHeight || doc.documentElement.clientHeight);
        if (width <= 0 || height <= 0) return;
        const set = (node, values) => {
            for (const [property, value] of Object.entries(values)) {
                if (node.style.getPropertyValue(property) !== value || node.style.getPropertyPriority(property) !== 'important') {
                    node.style.setProperty(property, value, 'important');
                }
            }
        };
        const dimensions = { width: `${width}px`, height: `${height}px`, 'max-width': 'none', 'max-height': 'none',
            'min-width': '0px', 'min-height': '0px', margin: '0px', padding: '0px', border: '0px', 'box-sizing': 'border-box' };
        set(shell, { ...dimensions, position: 'fixed', left: `${viewport?.offsetLeft || 0}px`,
            top: `${viewport?.offsetTop || 0}px`, right: 'auto', bottom: 'auto', overflow: 'hidden', 'pointer-events': 'none' });
        for (const s of sessions.values()) if (s.frame) {
            set(s.frame, { ...dimensions, position: 'absolute', left: '0px', top: '0px', right: 'auto', bottom: 'auto' });
        }
    }
    host.addEventListener('resize', layoutSessions);
    host.visualViewport?.addEventListener('resize', layoutSessions);
    host.visualViewport?.addEventListener('scroll', layoutSessions);
    let sessionLayoutFrame = null;
    const scheduleSessionLayout = () => {
        if (disposed || sessionLayoutFrame !== null) return;
        sessionLayoutFrame = host.requestAnimationFrame(() => { sessionLayoutFrame = null; if (!disposed) layoutSessions(); });
    };
    const sessionSizer = typeof host.ResizeObserver === 'function' ? new host.ResizeObserver(scheduleSessionLayout) : null;
    sessionSizer?.observe(shell);
    teardown.push(() => {
        sessionSizer?.disconnect(); host.cancelAnimationFrame(sessionLayoutFrame); host.removeEventListener('resize', layoutSessions);
        host.visualViewport?.removeEventListener('resize', layoutSessions);
        host.visualViewport?.removeEventListener('scroll', layoutSessions);
    });
    layoutSessions();
    function setFloating(node, visible) {
        if (iosBrowser) node.dataset.ptFixedFallback = 'true';
        if ((node === launcher || node === completionBadge) && !launcherVisible) {
            try { if (node.matches(':popover-open')) node.hidePopover(); } catch {}
            node.hidden = true; node.style.setProperty('display', 'none', 'important'); return;
        }
        if (node === launcher) node.hidden = false;

        if (typeof node.showPopover === 'function' && node.dataset.ptFixedFallback !== 'true') {
            node.setAttribute('popover', 'manual');
            try {
                const open = node.matches(':popover-open');
                if (visible && !open) node.showPopover();
                if (!visible && open) node.hidePopover();
            } catch {
                // A closed/unsupported popover can remain suppressed by the WebView.
                // Remove the attribute before falling back to ordinary fixed positioning.
                node.removeAttribute('popover'); node.dataset.ptFixedFallback = 'true';
            }
        } else node.removeAttribute('popover');
        if (visible) {
            node.style.setProperty('display', 'block', 'important');
            node.style.setProperty('visibility', 'visible', 'important');
            node.style.setProperty('opacity', '1', 'important');
            node.style.setProperty('position', 'fixed', 'important');
            if (node === launcher || node === panel || node === completionBadge) {
                node.style.setProperty('transform', 'none', 'important');
                node.style.setProperty('content-visibility', 'visible', 'important');
                node.style.setProperty('pointer-events', node === completionBadge ? 'none' : 'auto', 'important');
            }
        } else node.style.removeProperty('display');
    }
    function draggable(node, handle) {
        let drag = null, suppressClick = false;
        node.addEventListener('pointerdown', e => {
            if (e.button !== 0 || !handle(e.target)) return;
            const rect = node.getBoundingClientRect();
            drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
            node.setPointerCapture?.(e.pointerId);
        });
        node.addEventListener('pointermove', e => {
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) < 5 && !drag.moved) return;
            drag.moved = true; e.preventDefault();
            node.dataset.ptDragged = 'true';
            const bounds = floatingBounds();
            const left = Math.max(bounds.left, Math.min(bounds.right - node.offsetWidth, drag.left + dx));
            const top = Math.max(bounds.top, Math.min(bounds.bottom - node.offsetHeight, drag.top + dy));
            node.style.setProperty('left', left + 'px', 'important');
            node.style.setProperty('top', top + 'px', 'important');
            node.style.setProperty('right', 'auto', 'important');
            node.style.setProperty('bottom', 'auto', 'important');
            node.style.setProperty('margin', '0', 'important');
            if (node === launcher) positionCompletionBadge();
        });
        node.addEventListener('pointerup', () => { suppressClick = !!drag?.moved; drag = null; });
        node.addEventListener('pointercancel', () => { drag = null; });
        node.addEventListener('click', e => { if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    }
    draggable(launcher, () => true);
    draggable(panel, target => !!target.closest?.('.pt-heading'));
    function keepFloatingVisible() {
        if (disposed) return;
        const b = floatingBounds();
        const width = Math.max(1, b.right - b.left), height = Math.max(1, b.bottom - b.top);
        const compact = width < 600 || height < 500;
        const panelReserve = compact ? (launcher.offsetHeight || 56) + 18 : 146;
        const set = (e, k, v) => { if (e.style.getPropertyValue(k) !== v) e.style.setProperty(k, v, 'important'); };
        for (const node of [launcher, panel]) {
            set(node, 'max-width', `${width}px`);
            if (node === panel) {
                set(node, 'width', `${Math.min(364, width)}px`);
                set(node, 'max-height', `${Math.max(1, height - panelReserve)}px`);
            }
            if (node.hidden || !node.offsetHeight) continue;
            const rect = node.getBoundingClientRect();
            const preferredTop = node.dataset.ptDragged ? rect.top : b.bottom - rect.height - (node === panel ? panelReserve : compact ? 0 : 76);
            const top = Math.max(b.top, Math.min(b.bottom - rect.height, preferredTop));
            const left = Math.max(b.left, Math.min(b.right - rect.width, node.dataset.ptDragged ? rect.left : b.right - rect.width));
            set(node, 'top', `${top}px`); set(node, 'left', `${left}px`);
            set(node, 'right', 'auto'); set(node, 'bottom', 'auto'); set(node, 'margin', '0px');
        }
        if (!toast.hidden) {
            set(toast, 'max-width', `${width}px`); set(toast, 'max-height', `${height}px`); set(toast, 'overflow', 'auto');
            set(toast, 'left', `${(b.left + b.right) / 2}px`);
            set(toast, 'top', `${Math.max(b.top, b.bottom - toast.offsetHeight)}px`); set(toast, 'bottom', 'auto');
        }
        positionCompletionBadge();
    }
    let floatingLayoutFrame = null;
    const scheduleFloatingLayout = () => {
        if (disposed || floatingLayoutFrame !== null) return;
        floatingLayoutFrame = host.requestAnimationFrame(() => { floatingLayoutFrame = null; if (!disposed) keepFloatingVisible(); });
    };
    const floatObserver = typeof host.ResizeObserver === 'function' ? new host.ResizeObserver(scheduleFloatingLayout) : null;
    floatObserver?.observe(panel); floatObserver?.observe(launcher); floatObserver?.observe(toast);
    host.addEventListener('resize', keepFloatingVisible);
    host.visualViewport?.addEventListener('resize', keepFloatingVisible);
    host.visualViewport?.addEventListener('scroll', keepFloatingVisible);
    teardown.push(() => { floatObserver?.disconnect(); host.cancelAnimationFrame(floatingLayoutFrame); host.removeEventListener('resize', keepFloatingVisible);
        host.visualViewport?.removeEventListener('resize', keepFloatingVisible); host.visualViewport?.removeEventListener('scroll', keepFloatingVisible); });
    const notify = message => {
        toast.textContent = message; toast.hidden = false; setFloating(toast, true);
        host.clearTimeout(toastTimer); toastTimer = host.setTimeout(() => { toast.hidden = true; setFloating(toast, false); }, 6500);
    };

    function chatTimestamp(value) {
        if (value == null || value === '') return 0;
        const number = Number(value);
        const time = Number.isFinite(number) ? number : Date.parse(value);
        return Number.isFinite(time) && time > 0 ? time : 0;
    }
    function identity(session) {
        if (!session.ready) return;
        try {
            const c = ctx(session.win);
            session.avatar = c.characters[c.characterId]?.avatar || null;
            if (session.avatar) {
                const time = chatTimestamp(c.characters[c.characterId]?.date_last_chat);
                recentChatTimes.set(session.avatar, Math.max(time, recentChatTimes.get(session.avatar) || 0));
            }
            session.title = c.characters[c.characterId]?.name || (c.groupId ? '群聊（原生模式）' : '主页面');
            session.chatId = c.chatId || c.getCurrentChatId?.() || null;
        } catch { /* document may still be loading */ }
    }
    function isGenerating(session) {
        try { return !!(session.busy || session.win.__PT_CORE__?.is_send_press === true); }
        catch { return !!session.busy; }
    }
    function isSaving(session) {
        try { return session.win.__PT_CORE__?.isChatSaving === true; }
        catch { return false; }
    }
    function activityLabel(session) {
        return isGenerating(session) ? '正在回复…' : isSaving(session) ? '正在保存…' : session.status;
    }
    function isBusy(session) {
        try {
            return isGenerating(session) || isSaving(session);
        } catch { return session.busy; }
    }
    function preview(session) {
        try {
            const messages = ctx(session.win).chat;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i] && !messages[i].is_user && !messages[i].is_system) return String(messages[i].mes || '').slice(-420);
            }
        } catch { /* not ready */ }
        return '';
    }
    panel.addEventListener('pointerdown', () => { pointerActive = true; }, true);
    host.addEventListener('pointerup', releasePointer, true);
    host.addEventListener('pointercancel', releasePointer, true);
    function releasePointer() { pointerActive = false; }
    teardown.push(() => { host.removeEventListener('pointerup', releasePointer, true); host.removeEventListener('pointercancel', releasePointer, true); });
    function queueRender() {
        if (renderPending || disposed) return;
        renderPending = true;
        host.setTimeout(() => { renderPending = false; if (!disposed) { if (pointerActive) queueRender(); else render(); } }, 160);
    }
    function chatScroller(w) {
        const d = w.document;
        let node = d.querySelector('#chat .mes[mesid], .mes[mesid]')?.parentElement;
        while (node && node !== d.body) {
            if (node.clientHeight > 0 && node.scrollHeight > node.clientHeight && /auto|scroll/.test(w.getComputedStyle(node).overflowY)) return node;
            node = node.parentElement;
        }
        return d.querySelector('#chat, #dialogue, .chat-container, #chat_story_container, .list-messages, .chatdisplay') || d.scrollingElement;
    }
    function rememberReading(session) {
        if (!session?.win || !session.ready) return;
        try {
            const w = session.win, el = chatScroller(w);
            if (!el) return;
            const top = el === w.document.scrollingElement ? 0 : el.getBoundingClientRect().top + el.clientTop;
            const anchor = [...el.querySelectorAll('.mes[mesid]')].find(n => n.getBoundingClientRect().bottom > top && n.getBoundingClientRect().height > 0);
            session.reading = { chatId: ctx(w).chatId || ctx(w).getCurrentChatId?.(),
                scrollTop: el.scrollTop, bottom: el.scrollHeight - el.clientHeight - el.scrollTop < 8,
                mesid: anchor?.getAttribute('mesid'), offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
        } catch {}
    }
    function restoreReading(session) {
        cancelReadingRestore();
        const saved = session?.reading, w = session?.win;
        if (!saved || !w) return;
        let cancelled = false;
        const cancel = () => { cancelled = true; };
        const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
        for (const name of inputs) w.addEventListener(name, cancel, { capture: true, passive: true });
        const apply = () => {
            if (cancelled || disposed || activeId !== session.id || (ctx(w).chatId || ctx(w).getCurrentChatId?.()) !== saved.chatId) return;
            const el = chatScroller(w); if (!el) return;
            const anchor = [...el.querySelectorAll('.mes[mesid]')].find(n => n.getAttribute('mesid') === saved.mesid);
            const top = el === w.document.scrollingElement ? 0 : el.getBoundingClientRect().top + el.clientTop;
            const value = saved.bottom ? el.scrollHeight - el.clientHeight : anchor ? el.scrollTop + anchor.getBoundingClientRect().top - top - saved.offset : saved.scrollTop;
            el.scrollTo({ top: value, behavior: 'instant' });
        };
        const raf = host.requestAnimationFrame(() => { apply(); });
        const timer = host.setTimeout(() => { apply(); cleanup(); }, 180);
        const cleanup = () => { cancel(); host.cancelAnimationFrame(raf); host.clearTimeout(timer); for (const name of inputs) w.removeEventListener(name, cancel, true); };
        cancelReadingRestore = cleanup;
    }
    let cancelReadingRestore = () => {};
    teardown.push(() => cancelReadingRestore());
    function setActive(id) {
        lastAction = { action: 'view-session', session: id, time: new Date().toISOString() };
        if (!sessions.has(id)) return;
        if (!sessions.get(id).ready && !sessions.get(id).needsConfirmation) {
            panelOpen = true; pickerOpen = false; render();
            notify(sessions.get(id).error || '这个角色还在加载，请稍等。');
            return;
        }
        const switching = activeId !== id;
        if (switching) recordPageStage(id === 'main' ? '切换到主窗口' : '切换到副窗口');
        if (switching) { sessions.get(activeId)?.profile?.flush(); void sessions.get(id).profile?.activate(); }
        if (switching) { cancelReadingRestore(); rememberReading(sessions.get(activeId)); }
        activeId = id;
        sessions.get(id).unreadCompletion = false;
        layoutSessions();
        for (const session of sessions.values()) {
            if (session.frame) {
                const hidden = session.id !== id;
                session.frame.classList.toggle('pt-hidden', hidden);
                session.frame.setAttribute('aria-hidden', String(hidden));
                session.frame.inert = hidden;
            }
        }
        panelOpen = false; pickerOpen = false; render();
        if (switching) restoreReading(sessions.get(id));
        // Do not move or remove frames: doing so can tear down their browsing context.
    }
    panel.addEventListener('cancel', e => { e.preventDefault(); panelOpen = false; pickerOpen = false; render(); });
    function updateLauncher() {
        const all = [...sessions.values()];
        const running = all.filter(isGenerating).length;
        const completed = enabled ? all.filter(s => s.unreadCompletion) : [];
        launcher.dataset.completed = String(completed.length);
        const signature = JSON.stringify([enabled, running, completed.length, all.map(s => [s.title, s.avatar])]);
        if (signature !== launcherSignature) {
            launcherSignature = signature;
            const dock = element('span', 'pt-dock'), faces = element('span', 'pt-dock-faces');
            for (const s of (enabled ? all : [main])) {
                const face = portrait(s); face.dataset.ptSession = s.id; faces.append(face);
            }
            const label = element('span', 'pt-dock-label', completed.length ? `${completed.length} 个已完成` : '并行会话');
            label.append(element('span', 'pt-dock-note', enabled ? (running ? `${running} 个正在回复` : '点开查看会话') : '点击开启'));
            dock.append(faces, label);
            launcher.replaceChildren(dock);
        }
        const nextBadgeSignature = JSON.stringify(completed.map(session => session.id));
        if (badgeSignature !== nextBadgeSignature) {
        badgeSignature = nextBadgeSignature;
        completionBadge.replaceChildren(...completed.map(session => {
            const badge = element('span', 'pt-avatar-badge', '1');
            badge.dataset.ptSession = session.id;
            return badge;
        }));
        }
        completionBadge.hidden = completed.length === 0;
        setFloating(completionBadge, completed.length > 0); positionCompletionBadge();
        const label = completed.length ? `并行对话：${completed.map(s => s.title).join('、')} 已生成完成，待查看` : '并行对话';
        launcher.title = label; launcher.setAttribute('aria-label', label);
    }
    function applyTheme() { for (const node of [panel, launcher, toast, completionBadge]) node.dataset.night = String(nightMode); }
    function setNightMode(value) {
        nightMode = !!value;
        try { host.localStorage.setItem('parallel-tavern.night-mode', nightMode ? 'on' : 'off'); } catch {}
        applyTheme(); render();
        host.dispatchEvent(new host.CustomEvent('pt-night-mode', { detail: nightMode }));
    }
    function render() {
        applyTheme();
        if (disposed) return;
        for (const session of sessions.values()) identity(session);
        updateLauncher();
        launcher.setAttribute('aria-expanded', String(panelOpen || pickerOpen));
        if (!panelOpen) setFloating(panel, false);
        panel.hidden = !panelOpen; picker.hidden = !pickerOpen;
        if (panelOpen) setFloating(panel, true);
        setFloating(launcher, true);
        keepFloatingVisible();
        // Raise the independent badge after the launcher in the browser top layer.
        if (!completionBadge.hidden) { setFloating(completionBadge, false); setFloating(completionBadge, true); positionCompletionBadge(); }
        if (!panelOpen) panel.style.removeProperty('display');
        if (!panelOpen) return;
        if (pickerOpen) {
            if (picker.parentNode !== panel) panel.replaceChildren(picker);
            return; // Preserve the search input and focus during status refreshes.
        }
        panel.replaceChildren();
        const row = element('div', 'pt-row');
        const heading = element('span', 'pt-heading', 'Parallel');
        heading.append(element('span', 'pt-subheading', '并 行 会 话'));
        row.append(heading);
        if (enabled) { const add = button('＋ 打开对话', showPicker, '打开对话'); add.classList.add('pt-add'); row.append(add); }
        row.append(iconButton('收起', 'minus', () => { panelOpen = false; render(); }));
        panel.append(row);
        if (!enabled) {
            const welcome = element('div', 'pt-welcome');
            welcome.append(element('p', 'pt-muted', '一个角色在回复，也能继续另一场对话。最多同时保留 3 个会话。'));
            welcome.append(button('开启角色并行', () => {
                if (!appReady) return notify('酒馆还在初始化，请稍后再试。');
                if (ctx(host).groupId) return notify('这一版支持单角色聊天，请先打开一个角色。');
                enabled = true; render(); notify('已开启。可点击角色列表切换，也可用“打开对话”。');
            })); panel.append(welcome);
            return;
        }
        const overview = element('div', 'pt-overview');
        overview.append(element('span', 'pt-live-count', `${[...sessions.values()].filter(isGenerating).length} 正在回复`), element('span', 'pt-ready-count', `${[...sessions.values()].filter(s => s.unreadCompletion).length} 待查看`));
        panel.append(overview);
        const section = element('div', 'pt-section-label', '对话'); section.append(element('span', '', `${sessions.size} / ${MAX_SESSIONS}`)); panel.append(section);
        const list = element('div', 'pt-session-list'); panel.append(list);
        for (const session of sessions.values()) {
            const card = element('div', `pt-card${activeId === session.id ? ' pt-active' : ''}`);
            card.dataset.session = session.id;
            card.dataset.busy = String(isGenerating(session)); card.dataset.unread = String(!!session.unreadCompletion);
            const sessionRow = element('div', 'pt-session-row');
            const open = button('', () => setActive(session.id), '查看此会话'); open.classList.add('pt-session-open');
            const copy = element('span', 'pt-session-copy');
            const title = element('span', 'pt-title');
            title.append(element('span', 'pt-name', session.title));
            if (activeId === session.id) title.append(element('span', 'pt-current', '当前'));
            else if (session.unreadCompletion) title.append(element('span', 'pt-completed', '新回复'));
            copy.append(title, element('span', 'pt-chat-name', session.chatId || session.targetChat || '最近聊天'), element('span', 'pt-preview', preview(session).replace(/\s+/g, ' ') || '点击进入对话'), element('span', 'pt-status', `${session.id === 'main' ? '主页面 · ' : ''}${activityLabel(session)}`));
            open.append(portrait(session), copy); sessionRow.append(open);
            const more = iconButton('会话操作', 'more', () => { controlsId = controlsId === session.id ? null : session.id; render(); });
            more.setAttribute('aria-expanded', String(controlsId === session.id)); sessionRow.append(more); card.append(sessionRow);
            if (session.error) card.append(element('p', 'pt-error', session.error));
            if (controlsId === session.id) {
                const controls = element('div', 'pt-actions');
                if (isGenerating(session)) controls.append(button('停止生成', () => stopSession(session)));
                if (session.id !== 'main') {
                    const close = button('关闭窗口', () => closeSession(session));
                    close.disabled = isBusy(session); controls.append(close);
                }
                if (!controls.childElementCount) controls.append(element('span', 'pt-muted', '这是主页面，无需关闭'));
                card.append(controls);
            }
            list.append(card);
        }
        const footer = element('div', 'pt-footer');
        footer.append(button('退出并行', endParallel), element('span', '', '保持页面开启'), button('设置', () => { menuOpen = !menuOpen; render(); })); panel.append(footer);
        if (menuOpen) {
            const menu = element('div', 'pt-menu');
            menu.append(button('复制诊断', exportDiagnostics));
            const theme = button('夜间模式：' + (nightMode ? '开启' : '关闭'), () => setNightMode(!nightMode), '夜间模式');
            theme.setAttribute('role', 'switch'); theme.setAttribute('aria-checked', String(nightMode)); menu.append(theme);
            const sound = button(`完成提示音：${soundEnabled ? '开启' : '关闭'}`, () => {
                soundEnabled = !soundEnabled;
                try { host.localStorage.setItem(soundKey, soundEnabled ? 'on' : 'off'); } catch {}
                if (soundEnabled) unlockSound();
                else for (const tone of sounding) { try { tone.stop(); } catch {} }
                render();
            }, '完成提示音');
            sound.setAttribute('role', 'switch'); sound.setAttribute('aria-checked', String(soundEnabled)); menu.append(sound);
            const tips = element('details'); tips.append(element('summary', '', '使用说明'), element('p', 'pt-muted', '点击对话行切换窗口；打开对话里可直接进入角色最近聊天，也可选择其他对话。刷新或退出页面会结束这些会话。子会话设置临时生效，永久设置请在主页面修改。')); menu.append(tips); panel.insertBefore(menu, footer);
        }
    }
    function refreshLiveStatus() {
        if (pointerActive) return;
        updateLauncher();
        if (!panelOpen || pickerOpen) return;
        for (const card of panel.querySelectorAll('.pt-card[data-session]')) {
            const session = sessions.get(card.dataset.session);
            if (!session) continue;
            const status = card.querySelector('.pt-status');
            const next = `${session.id === 'main' ? '主页面 · ' : ''}${activityLabel(session)}`;
            if (status && status.textContent !== next) status.textContent = next;
            card.dataset.busy = String(isGenerating(session));
            const snippet = card.querySelector('.pt-preview'), text = preview(session).replace(/\s+/g, ' ') || '点击进入对话';
            if (snippet && snippet.textContent !== text) snippet.textContent = text;
        }
        const live = panel.querySelector('.pt-live-count'); if (live) live.textContent = `${[...sessions.values()].filter(isGenerating).length} 正在回复`;
    }
    function showPicker() {
        recordPageStage('打开角色搜索');
        if (!enabled) return;
        pickerOpen = true; panelOpen = true;
        picker.replaceChildren();
        const row = element('div', 'pt-row');
        row.append(element('span', 'pt-heading', '打开对话'), button('返回', () => { pickerOpen = false; panelOpen = true; render(); }));
        const search = element('input'); search.id = 'pt-search'; search.placeholder = '搜索角色名称'; search.setAttribute('aria-label', '搜索角色名称');
        const list = element('div'); list.id = 'pt-character-list';
        const fill = () => {
            list.replaceChildren();
            const filter = search.value.toLocaleLowerCase();
            for (const session of sessions.values()) identity(session);
            const characters = ctx(host).characters.filter(c => c?.avatar && c.name?.toLocaleLowerCase().includes(filter));
            const recentTime = c => Math.max(chatTimestamp(c.date_last_chat), recentChatTimes.get(c.avatar) || 0);
            characters.sort((a, b) => recentTime(b) - recentTime(a));
            for (const c of characters.slice(0, 120)) {
                const item = element('div', 'pt-character-choice');
                const recent = button('', () => void openCharacter(c.avatar), c.name);
                const face = portrait({ title: c.name, avatar: c.avatar });
                const image = face.querySelector('img');
                if (image) { image.loading = 'lazy'; image.decoding = 'async'; }
                const copy = element('span', 'pt-character-copy', c.name);
                copy.append(element('span', 'pt-muted', '最近聊天'));
                recent.append(face, copy);
                const history = button('其他对话', () => void showHistory(c), `${c.name}的其他对话`);
                const arrow = element('span', 'pt-history-arrow', '→'); arrow.setAttribute('aria-hidden', 'true'); history.append(arrow);
                item.append(recent, history); list.append(item);
            }
            if (!characters.length) list.append(element('p', 'pt-muted', '没有匹配角色'));
            if (characters.length > 120) list.append(element('p', 'pt-muted', '仅显示前 120 个，请继续输入名称筛选。'));
        };
        search.addEventListener('input', fill);
        picker.append(row, search, list); fill(); render(); search.focus();
    }
    async function showHistory(character) {
        pickerOpen = true; panelOpen = true; picker.replaceChildren();
        const row = element('div', 'pt-row');
        row.append(element('span', 'pt-heading', character.name), button('返回', showPicker));
        const list = element('div', 'pt-history-list');
        list.id = 'pt-history-list';
        list.append(element('p', 'pt-muted', '正在读取聊天记录…')); picker.append(row, list); render();
        try {
            const response = await host.fetch(new URL('api/characters/chats', host.location.href).href, {
                method: 'POST', headers: ctx(host).getRequestHeaders(), body: JSON.stringify({ avatar_url: character.avatar, ch_name: character.name }),
            });
            if (!response.ok) throw new Error(`读取聊天记录失败（HTTP ${response.status}）`);
            const data = await response.json();
            if (!data || data.error) throw new Error('宿主未能返回聊天记录');
            if (!list.isConnected || !pickerOpen) return;
            const chats = Object.values(data).filter(x => x && typeof x.file_name === 'string');
            chats.sort((a, b) => String(b.last_mes || b.file_name).localeCompare(String(a.last_mes || a.file_name)));
            list.replaceChildren();
            for (const chat of chats) {
                const name = chat.file_name.replace(/\.jsonl$/i, '');
                const item = button('', () => void openCharacter(character.avatar, name), name);
                item.append(element('span', 'pt-history-name', name), element('span', 'pt-muted', `${chat.last_mes || ''}${chat.mes ? ' · ' + String(chat.mes).replace(/\s+/g, ' ').slice(-90) : ''}`));
                list.append(item);
            }
            if (!chats.length) list.append(element('p', 'pt-muted', '暂无其他聊天记录，可返回打开最近聊天。'));
        } catch (error) {
            if (!list.isConnected || !pickerOpen) return;
            list.replaceChildren(element('p', 'pt-error', shortError(error)), button('重试', () => void showHistory(character)));
        }
    }
    function on(emitter, name, fn, session) {
        if (!name || !emitter?.on) return;
        emitter.on(name, fn);
        session.cleanups.push(() => {
            if (emitter.removeListener) emitter.removeListener(name, fn);
            else emitter.off?.(name, fn);
        });
    }
    function attachSession(session) {
        if (host.__PT_INSTALL_CHARACTER_PROFILES__ && !session.profile) {
            session.profile = host.__PT_INSTALL_CHARACTER_PROFILES__(session.win, { busy: () => isBusy(session), notify });
            session.cleanups.push(() => session.profile.dispose());
        }
        if (host.__PT_INSTALL_SCROLL_QR_COMPAT__) session.cleanups.push(host.__PT_INSTALL_SCROLL_QR_COMPAT__(session.win, () => sessions.get(activeId)?.win || host));
        const w = session.win, c = ctx(w), events = c.eventTypes || c.event_types;
        if (w !== host) session.cleanups.push(bindAudioGesture(w));
        on(c.eventSource, events.GENERATION_STARTED, (_type, _options, dryRun) => {
            if (dryRun) return;
            recordPageStage(session.id === 'main' ? '主窗口开始生成' : '副窗口开始生成');
            session.unreadCompletion = false;
            session.busy = true; session.status = '生成中'; session.error = null; queueRender();
        }, session);
        on(c.eventSource, events.GENERATION_ENDED, () => {
            recordPageStage(session.id === 'main' ? '主窗口生成结束' : '副窗口生成结束');
            const wasBusy = session.busy; session.busy = false; session.status = '生成已结束';
            if (wasBusy && enabled) completionSound();
            if (wasBusy && enabled && activeId !== session.id) session.unreadCompletion = true;
            queueRender();
            if (wasBusy && enabled && activeId !== session.id) notify(`${session.title} 的生成已结束，可以切回查看。`);
        }, session);
        on(c.eventSource, events.GENERATION_STOPPED, () => {
            recordPageStage(session.id === 'main' ? '主窗口停止生成' : '副窗口停止生成');
            // Native core can still be saving after STOPPED; isBusy also reads it.
            session.busy = false; session.status = '已停止'; queueRender();
        }, session);
        on(c.eventSource, events.CHAT_CHANGED, () => { identity(session); queueRender(); }, session);
        const capture = e => {
            if (!enabled || !session.ready) return;
            const target = e.target?.closest?.('.character_select[data-chid]');
            if (target) {
                const char = ctx(w).characters[Number(target.dataset.chid)];
                if (!char?.avatar) return;
                identity(session);
                if (char.avatar === session.avatar) return;
                e.preventDefault(); e.stopImmediatePropagation();
                void openCharacter(char.avatar);
            } else if (e.target?.closest?.('.group_select')) {
                e.preventDefault(); e.stopImmediatePropagation();
                notify('试用版仅支持单角色。请结束并行模式后使用群聊。');
            }
        };
        w.addEventListener('click', capture, true);
        session.cleanups.push(() => w.removeEventListener('click', capture, true));
        // Read-only access to native busy/save state, imported in that document's realm.
        const core = w.document.createElement('script'); core.type = 'module';
        core.textContent = `import * as core from ${JSON.stringify(new URL('script.js', host.location.href).href)}; window.__PT_CORE__ = core;`;
        w.document.head.append(core);
        session.cleanups.push(() => core.remove());
    }
    async function stopSession(session) {
        try { await ctx(session.win).stopGeneration(); session.status = '正在停止'; queueRender(); }
        catch (error) { notify(`停止失败：${shortError(error)}`); }
    }
    function releaseChild(session) {
        session.abort?.abort();
        host.clearTimeout(session.timeout);
        runCleanups(session.cleanups);
        if (session.frame) sessionSizer?.unobserve(session.frame);
        session.frame?.remove();
        session.frame = null; session.win = null; session.profile = null;
    }
    function failChildSession(session, error, phase = '副窗口加载失败') {
        if (disposed || sessions.get(session.id) !== session || session.error) return;
        session.error = shortError(error); session.status = '已停止'; session.phase = phase;
        session.ready = false; session.busy = false; session.needsConfirmation = false;
        releaseChild(session);
        syncIOSCompositing();
        if (activeId === session.id) setActive('main');
        recordPageStage(phase); queueRender(); notify(session.error);
    }
    function closeSession(session) {
        if (session.id === 'main') return;
        if (isBusy(session)) return notify('请先停止或等待这个角色生成、保存结束。');
        identity(session);
        if (session.ready) {
            const input = session.win.document.querySelector('#send_textarea');
            if (input?.value && !host.confirm('这个会话还有未发送的草稿。仍然关闭？')) return;
        }
        releaseChild(session); sessions.delete(session.id);
        syncIOSCompositing();
        recordPageStage('关闭副窗口');
        if (activeId === session.id) setActive('main');
        render();
    }
    function endParallel() {
        if ([...sessions.values()].some(isBusy)) return notify('还有角色在生成或保存。请等待完成，或先分别停止。');
        for (const s of [...sessions.values()]) if (s.id !== 'main') closeSession(s);
        if (sessions.size > 1) return;
        enabled = false; setActive('main'); panelOpen = true; render();
    }

    async function loadHTML() {
        if (!appHTML) appHTML = (async () => {
            const url = new URL(host.location.href); url.hash = ''; url.search = '';
            const res = await host.fetch(url.href, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`无法读取酒馆页面（HTTP ${res.status}）`);
            const html = await res.text();
            if (!/<html[\s>]/i.test(html) || !/script/i.test(html)) throw new Error('宿主没有返回酒馆页面 HTML');
            return html;
        })().catch(error => { appHTML = null; throw error; });
        return appHTML;
    }

    // This prelude executes BEFORE native scripts in each child document. It uses the
    // existing TT bridge, retains native stream parsing, and isolates settings.
    function childPrelude(id, avatar, baseURL, protectExisting) {
        const parentHost = window.parent;
        window.__PT_CHILD_ID__ = id;
        const trace = window.__PT_BOOT_TRACE__ = { requests: [], resourceErrors: {} };
        trace.chatProtection = { existingHistory: !!protectExisting, blockedWrites: 0, verified: false };
        window.__PT_CHAT_WRITE_READY__ = !protectExisting;
        const guardChatWrite = () => {
            if (window.__PT_CHAT_WRITE_READY__) return;
            trace.chatProtection.blockedWrites++;
            throw new Error('历史聊天尚未验证，已阻止副窗口写入。请关闭此副窗口后重试，不要在空白对话中继续生成。');
        };
        // TT's focus keeper uses instanceof. Host iframe integrations can expose
        // constructors from another realm, or adopt real elements from one.
        // Keep this child realm's constructor and use the native DOM getter as
        // the brand check. A DIV or a tagName-shaped object must still fail.
        const NativeTextarea = window.HTMLTextAreaElement;
        const inputCompat = trace.inputCompat = { installed: false, constructorWrites: 0, foreignNodeMatches: 0, types: {} };
        if (parentHost.__TAURITAVERN__ || parentHost.__TAURI_RUNNING__) {
            const nativeInstance = Function.prototype[Symbol.hasInstance];
            // Each getter performs the browser's native interface brand check.
            // No tag-name duck typing, prototype rewriting or parent mutation.
            const brands = { Node: 'nodeType', Element: 'tagName', HTMLElement: 'title',
                HTMLTextAreaElement: 'value', HTMLInputElement: 'value', HTMLSelectElement: 'selectedIndex',
                HTMLOptionElement: 'selected', HTMLButtonElement: 'disabled', HTMLFormElement: 'name',
                HTMLDivElement: 'align', HTMLDialogElement: 'open', HTMLIFrameElement: 'name',
                HTMLImageElement: 'alt', HTMLAnchorElement: 'target', HTMLLabelElement: 'htmlFor',
                HTMLCanvasElement: 'width', HTMLVideoElement: 'videoWidth', HTMLMediaElement: 'paused',
                CharacterData: 'data', Document: 'documentElement', SVGElement: 'ownerSVGElement' };
            for (const [name, property] of Object.entries(brands)) {
                const Ctor = window[name];
                const getter = Ctor && Object.getOwnPropertyDescriptor(Ctor.prototype, property)?.get;
                if (!getter) continue;
                try {
                    const stats = inputCompat.types[name] = { matches: 0, writes: 0 };
                    Object.defineProperty(Ctor, Symbol.hasInstance, { configurable: true, value(value) {
                        if (nativeInstance.call(this, value)) return true;
                        if (this !== Ctor) return false;
                        try {
                            getter.call(value);
                            if (value !== document && value.ownerDocument !== document) return false;
                            stats.matches++; inputCompat.foreignNodeMatches++;
                            return true;
                        } catch { return false; }
                    } });
                    Object.defineProperty(window, name, { configurable: true,
                        get: () => Ctor,
                        set: value => { if (value !== Ctor) { stats.writes++; inputCompat.constructorWrites++; } } });
                } catch { delete inputCompat.types[name]; }
            }
            inputCompat.installed = !!inputCompat.types.HTMLTextAreaElement && !!inputCompat.types.HTMLElement;
        }
        // Structural facts only. Never retain input values, HTML, or chat text.
        const inputState = () => {
            const input = document.querySelector('#send_textarea');
            return { count: document.querySelectorAll('#send_textarea').length,
                tag: input?.tagName || null, localTextarea: input instanceof HTMLTextAreaElement,
                originalPrototypeMatch: Function.prototype[Symbol.hasInstance].call(NativeTextarea, input),
                originalConstructorActive: window.HTMLTextAreaElement === NativeTextarea,
                connected: !!input?.isConnected, documentReady: document.readyState };
        };
        window.__PT_INPUT_STATE__ = inputState;
        document.addEventListener('DOMContentLoaded', () => { trace.inputAtDOMContentLoaded = inputState(); }, { once: true });
        const report = (phase, issue) => parentHost.__PARALLEL_TAVERN_V2__?.reportChild(window, id, phase, issue);
        function errorDetails(error, file, line, column) {
            const message = String(error?.message || '');
            const kind = /content security|unsafe-eval|unsafe-inline/i.test(message) ? 'CSP' : /fetch|network|load.*module/i.test(message) ? 'RESOURCE_OR_NETWORK' : /not defined/.test(message) ? 'UNDEFINED_GLOBAL' : /Cannot read|Cannot set|undefined|null/.test(message) ? 'MISSING_VALUE' : /not a function/.test(message) ? 'MISSING_FUNCTION' : 'RUNTIME_ERROR';
            const basename = value => { try { const part = new URL(value, baseURL).pathname.split('/').pop(); return /^[\w.-]+\.(?:m?js|html)$/.test(part) ? part.slice(0, 100) : '(inline)'; } catch { return '(unknown)'; } };
            const frames = [...String(error?.stack || '').matchAll(/((?:https?|tauri|asset):\/\/[^\s)]+?):(\d+):(\d+)/g)].slice(0, 5).map(m => ({ file: basename(m[1]), line: Number(m[2]), column: Number(m[3]) }));
            const inputFailure = message === 'Expected #send_textarea to exist';
            if (inputFailure) trace.inputAtError = inputState();
            return { name: ['Error','TypeError','ReferenceError','SyntaxError','RangeError','URIError','EvalError','AggregateError'].includes(error?.name) ? error.name : 'Error', kind: inputFailure ? 'CHAT_INPUT_MISSING' : kind,
                file: file ? basename(file) : null, line: Number(line) || null, column: Number(column) || null, frames };
        }
        report('子页面引导脚本已执行');
        window.addEventListener('error', e => {
            if (e.target?.tagName === 'SCRIPT') {
                let requiredEntry = false;
                try {
                    const source = new URL(e.target.src, baseURL), entry = new URL('script.js', baseURL);
                    requiredEntry = source.origin === entry.origin && source.pathname === entry.pathname;
                } catch {}
                report('脚本资源加载失败', { ...errorDetails(null, e.target.src), kind: requiredEntry ? 'CORE_SCRIPT_LOAD_FAILED' : 'SCRIPT_LOAD_FAILED' });
            }
            else if (e.target !== window) {
                const tag = e.target?.tagName || 'OTHER';
                trace.resourceErrors[tag] = (trace.resourceErrors[tag] || 0) + 1;
            } else if (e.error || e.message) report('子页面执行错误', errorDetails(e.error || { message: e.message }, e.filename, e.lineno, e.colno));
        }, true);
        window.addEventListener('unhandledrejection', e => report('子页面异步错误', errorDetails(e.reason)));
        const originalError = console.error.bind(console);
        console.error = (...args) => {
            const error = args.find(v => v && typeof v === 'object' && typeof v.message === 'string');
            report('子页面记录错误', error ? errorDetails(error) : { kind: 'CONSOLE_ERROR' });
            originalError(...args);
        };
        // Tauri does not consistently inject its JS API into same-origin frames.
        // Public Tauri functions keep their original callback registry in parent.
        const bridgeBytes = trace.bridgeBytes = { arrayBuffers: 0, uint8Arrays: 0, copiedBytes: 0, largestCopyBytes: 0 };
        const copied = bytes => { bridgeBytes.copiedBytes += bytes; bridgeBytes.largestCopyBytes = Math.max(bridgeBytes.largestCopyBytes, bytes); };
        const nativeCalls = trace.nativeCalls = { started: 0, pending: 0, peakPending: 0, failed: 0, recent: [] };
        // Record categories only. Never retain command arguments, paths, URLs or payloads.
        const commandCategory = command => /^(plugin:fs\||read_chat_bytes$|open_chat_backup_download$)/.test(command) ? 'file'
            : command === 'plugin:resources|close' ? 'resource-close'
            : /tokeniz/.test(command) ? 'tokenizer' : /settings/.test(command) ? 'settings'
            : /chat/.test(command) ? 'chat' : /extension/.test(command) ? 'extension' : 'other';
        trace.mainThread = { supported: false, longTasks: 0, longestMs: 0 };
        let performanceObserver;
        try {
            if (window.PerformanceObserver?.supportedEntryTypes?.includes('longtask')) {
                performanceObserver = new PerformanceObserver(list => {
                    for (const entry of list.getEntries()) { trace.mainThread.longTasks++; trace.mainThread.longestMs = Math.max(trace.mainThread.longestMs, Math.round(entry.duration)); }
                });
                performanceObserver.observe({ entryTypes: ['longtask'] }); trace.mainThread.supported = true;
            }
        } catch {}
        const diagnosticStopTimer = setTimeout(() => performanceObserver?.disconnect(), 90000);
        window.__PT_DIAGNOSTICS_STOP__ = () => { performanceObserver?.disconnect(); clearTimeout(diagnosticStopTimer); };
        window.addEventListener('pagehide', window.__PT_DIAGNOSTICS_STOP__, { once: true });
        function localizeBinary(value) {
            if (value instanceof ArrayBuffer || value instanceof Uint8Array) return value;
            // Keep IPC and callback ownership in the parent. Only the returned
            // byte value is copied into this realm for TT's instanceof checks.
            try {
                Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get.call(value);
                const copy = new Uint8Array(new Uint8Array(value));
                bridgeBytes.arrayBuffers++; copied(copy.byteLength);
                return copy.buffer;
            } catch {}
            if (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]') {
                const copy = new Uint8Array(value);
                bridgeBytes.uint8Arrays++; copied(copy.byteLength);
                return copy;
            }
            return value;
        }
        if (parentHost.__TAURI__) {
            const api = parentHost.__TAURI__, core = api.core;
            if (typeof core?.invoke === 'function') {
                const childApi = Object.create(api), childCore = Object.create(core);
                Object.defineProperty(childCore, 'invoke', { value: async (...args) => {
                    if (/^(?:(?:begin|append|finish)_chat_commit|(?:save|write|append|truncate|delete|rename|commit)_(?:character_|group_)?chat(?:_|$))/.test(args[0])) guardChatWrite();
                    const entry = { category: commandCategory(String(args[0])), state: 'pending', started: Date.now() };
                    nativeCalls.started++; nativeCalls.pending++; nativeCalls.peakPending = Math.max(nativeCalls.peakPending, nativeCalls.pending);
                    nativeCalls.recent.push(entry); if (nativeCalls.recent.length > 12) nativeCalls.recent.shift();
                    try { const result = localizeBinary(await core.invoke(...args)); entry.state = 'resolved'; return result; }
                    catch (error) { entry.state = 'rejected'; nativeCalls.failed++; throw error; }
                    finally { nativeCalls.pending--; entry.elapsedMs = Date.now() - entry.started; }
                }, configurable: true });
                Object.defineProperty(childApi, 'core', { value: childCore, configurable: true });
                // The inherited public event API registers callbacks in the
                // parent realm. Removing an iframe alone does not release them.
                const eventApi = api.event;
                if (typeof eventApi?.listen === 'function') {
                    const stops = new Set();
                    let closed = false;
                    const events = trace.bridgeEvents = { active: 0, pending: 0, cleanupErrors: 0 };
                    const release = fn => {
                        try { return Promise.resolve(fn()).catch(() => { events.cleanupErrors++; }); }
                        catch { events.cleanupErrors++; return Promise.resolve(); }
                    };
                    const subscribe = async (event, handler, options, once = false) => {
                        if (closed) throw new Error('Parallel session already closed');
                        let off = null, stopped = false;
                        const stop = () => {
                            if (stopped) return;
                            stopped = true; stops.delete(stop); events.active = stops.size;
                            if (off) return release(off);
                        };
                        events.pending++;
                        try {
                            off = await eventApi.listen(event, value => {
                                if (closed || stopped) return;
                                if (once) void stop();
                                handler(value);
                            }, options);
                            if (closed || stopped) { stopped = true; await release(off); }
                            else { stops.add(stop); events.active = stops.size; }
                            return stop;
                        } finally { events.pending--; }
                    };
                    const childEvents = Object.create(eventApi);
                    Object.defineProperty(childEvents, 'listen', { value: (event, handler, options) => subscribe(event, handler, options), configurable: true });
                    Object.defineProperty(childEvents, 'once', { value: (event, handler, options) => subscribe(event, handler, options, true), configurable: true });
                    Object.defineProperty(childApi, 'event', { value: childEvents, configurable: true });
                    window.__PT_BRIDGE_DISPOSE__ = () => {
                        closed = true;
                        for (const stop of [...stops]) void stop();
                    };
                    window.addEventListener('pagehide', window.__PT_BRIDGE_DISPOSE__, { once: true });
                }
                window.__TAURI__ = childApi;
            } else window.__TAURI__ = api;
        }
        if (parentHost.__TAURI_INTERNALS__) window.__TAURI_INTERNALS__ = parentHost.__TAURI_INTERNALS__;
        const originalFetch = window.fetch.bind(window);
        const isTT = !!parentHost.__TAURITAVERN__ || !!parentHost.__TAURI_RUNNING__;
        let localRevision = null;
        const bootDataError = message => {
            // The host may catch a failed startup fetch without APP_READY or
            // unhandledrejection. Report our own fatal validation explicitly.
            report('副窗口启动数据无效', { kind: 'BOOT_DATA_INVALID' });
            return new Error(message);
        };
        const readStartupJSON = async response => {
            try { return await response.json(); }
            catch { throw bootDataError('副窗口启动数据无法解析，已停止并释放窗口。'); }
        };
        // TT 2.x supplies this settings envelope inside /api/bootstrap instead
        // of /api/settings/get. Both startup paths must receive the same local
        // settings, before their native autoloadLastChat can run.
        const isolateSettingsPayload = payload => {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bootDataError('启动设置返回异常，已停止副窗口。');
            payload.enable_extensions_auto_update = false;
            if (payload.hash_algorithm && payload.settings_hash) localRevision = { hash_algorithm: payload.hash_algorithm, settings_hash: payload.settings_hash };
            else if (payload.tauritavern_settings_revision) localRevision = payload.tauritavern_settings_revision;
            const serialized = typeof payload.settings === 'string';
            let settings;
            try { settings = serialized ? JSON.parse(payload.settings) : payload.settings; }
            catch { throw bootDataError('启动设置无法解析，已停止副窗口。'); }
            if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
                // Open the verified target explicitly after APP_READY, rather
                // than loading the parent's last chat during child startup.
                settings.active_character = null; settings.active_group = null;
                payload.settings = serialized ? JSON.stringify(settings) : settings;
            }
            return payload;
        };
        // A host extension may wrap our fetch then assign it back. Mark the
        // options (not HTTP headers) so nested wrappers parse settings only once.
        const fetchPass = Symbol('parallel-tavern-fetch-pass');
        const wrapFetch = next => async (input, init = {}) => {
            if (init?.[fetchPass]) return next(input, init);
            init = { ...init, [fetchPass]: true };
            const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, baseURL);
            const method = String(init.method || input?.method || 'GET').toUpperCase();
            const local = url.origin === new URL(baseURL).origin;
            if (url.origin === new URL(baseURL).origin && method !== 'GET' && /\/api\/chats\/(save|save-metadata|rename|delete)$/.test(url.pathname)) guardChatWrite();
            if (url.origin === new URL(baseURL).origin && url.pathname.endsWith('/csrf-token')) {
                const headers = parentHost.SillyTavern?.getContext()?.getRequestHeaders?.();
                const token = headers && new Headers(headers).get('x-csrf-token');
                if (token) return new Response(JSON.stringify({ token }), { headers: { 'Content-Type': 'application/json' } });
            }
            if (url.origin === new URL(baseURL).origin && /\/api\/settings\/(save|patch)$/.test(url.pathname) && method === 'POST') {
                return new Response(JSON.stringify({ result: 'ok', ...(localRevision || {}) }), { headers: { 'Content-Type': 'application/json' } });
            }
            // Only route names and status/timing are retained: never bodies, query
            // strings, headers, API addresses or user filenames.
            let request = null;
            if ((!window.__PT_BOOT_DONE__ || Date.now() < (window.__PT_DIAGNOSTIC_UNTIL__ || 0)) && url.origin === new URL(baseURL).origin) {
                const match = url.pathname.match(/^\/api\/(settings|secrets|extensions|presets|characters|backgrounds|avatars|tokenizers|worldinfo|chats|users)\/([a-z-]+)$/);
                const route = match ? `/api/${match[1]}/${match[2]}` : ['/version','/csrf-token','/api/bootstrap'].includes(url.pathname) ? url.pathname : '(other local resource)';
                if (route !== '(other local resource)' && trace.requests.length >= 80) { const i = trace.requests.findIndex(r => r.state !== 'pending'); if (i >= 0) trace.requests.splice(i, 1); }
                if (route !== '(other local resource)' && trace.requests.length < 80) { request = { route, state: 'pending', started: Date.now() }; trace.requests.push(request); }
            }
            let response;
            try { response = await next(input, init); if (request) { request.state = 'responded'; request.status = response.status; request.elapsedMs = Date.now() - request.started; } }
            catch (error) { if (request) { request.state = 'rejected'; request.elapsedMs = Date.now() - request.started; } throw error; }
            if (local && url.pathname.endsWith('/api/bootstrap') && response.ok) {
                // Isolate startup settings while preserving the host's character
                // library and other data used by third-party extensions.
                const payload = await readStartupJSON(response);
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bootDataError('启动数据返回异常，已停止副窗口。');
                payload.settings = isolateSettingsPayload(payload.settings);
                return new Response(JSON.stringify(payload), { status: response.status, headers: { 'Content-Type': 'application/json' } });
            }
            if (local && url.pathname.endsWith('/api/settings/get') && response.ok) {
                // This response is replaced, so consume it once. clone() tees
                // the body and leaves a second large settings buffer unread.
                const payload = isolateSettingsPayload(await readStartupJSON(response));
                return new Response(JSON.stringify(payload), { status: response.status, headers: { 'Content-Type': 'application/json' } });
            }
            return response;
        };
        // Keep settings isolation when the host installs its supported fetch patch.
        let settingsFetch = wrapFetch(isTT ? parentHost.fetch.bind(parentHost) : originalFetch);
        Object.defineProperty(window, 'fetch', { configurable: true, get: () => settingsFetch, set: next => { if (next !== settingsFetch) settingsFetch = wrapFetch(next); } });
        const timer = setInterval(() => {
            if (!window.SillyTavern?.getContext) return;
            if (parentHost.__PARALLEL_TAVERN_V2__?.attachChild(window, id)) clearInterval(timer);
        }, 50);
        window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    }

    async function openCharacter(avatar, chatName = null) {
        if (!enabled || disposed) return;
        const character = ctx(host).characters.find(c => c?.avatar === avatar);
        if (!character) return notify('主页面没有找到这个角色，请先刷新角色列表。');
        const targetChat = chatName ?? null;
        for (const s of sessions.values()) {
            identity(s);
            if ((s.avatar || s.targetAvatar) === avatar && (!targetChat || (s.chatId || s.targetChat || null) === targetChat)) { setActive(s.id); return; }
        }
        if (sessions.size >= MAX_SESSIONS) {
            panelOpen = true; pickerOpen = false; render();
            return notify('最多保留 3 个会话。请先关闭一个已结束的子会话，再打开其他角色。');
        }
        if ([...sessions.values()].some(s => s.id !== 'main' && !s.ready && !s.error)) return notify('有一个副窗口正在加载，请等它就绪后再添加。');
        const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const s = { id, win: null, frame: null, ready: false, busy: false, status: '正在载入…', title: character.name, avatar: null, targetAvatar: avatar, targetChat, cleanups: [], abort: new host.AbortController() };
        // Reserve before awaiting, so fast double clicks cannot create duplicates.
        sessions.set(id, s); syncIOSCompositing(); panelOpen = true; pickerOpen = false; render();
        recordPageStage('开始打开副窗口');
        try {
            s.phase = '确认已有聊天记录';
            const historyResponse = await host.fetch(new URL('api/characters/chats', host.location.href).href, {
                method: 'POST', headers: ctx(host).getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, ch_name: character.name }),
                signal: s.abort.signal,
            });
            if (!historyResponse.ok) throw new Error('无法确认历史聊天，已停止打开副窗口，以免误建新档。');
            const history = await historyResponse.json();
            if (!sessions.has(id) || disposed) return;
            if (!history || typeof history !== 'object' || history.error) throw new Error('聊天列表返回异常，已停止打开副窗口。');
            const chats = Object.values(history).filter(c => c && typeof c.file_name === 'string');
            if (Object.values(history).length !== chats.length) throw new Error('无法识别聊天列表，已停止打开，未创建新档。');
            const fileName = c => c.file_name.replace(/\.jsonl$/i, '');
            if (targetChat && !chats.some(c => fileName(c) === targetChat)) throw new Error('指定聊天已不在历史列表中，已停止打开，未创建新档。');
            const historyTime = chat => {
                const raw = String(chat.last_mes || '');
                const match = raw.match(/(\d{4}-\d{2}-\d{2})@(\d{2})h(\d{2})m(\d{2})s/)
                    || chat.file_name.match(/(\d{4}-\d{2}-\d{2})@(\d{2})h(\d{2})m(\d{2})s/);
                return chatTimestamp(chat.last_mes) || (match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`) : 0) || 0;
            };
            const latest = [...chats].sort((a, b) => historyTime(b) - historyTime(a));
            const chosen = targetChat ? chats.find(c => fileName(c) === targetChat)
                : latest[0];
            s.targetChat = chosen ? fileName(chosen) : null;
            s.existingHistory = !!chosen;
            s.expectedMessages = Number(chosen?.chat_items) || 0;
            s.phase = '读取宿主 HTML';
            recordPageStage('读取副窗口页面');
            const html = await loadHTML();
            s.phase = 'HTML 已读取，准备子页面';
            if (!sessions.has(id) || disposed) return;
            const parsed = new host.DOMParser().parseFromString(html, 'text/html');
            s.sourceInput = { count: parsed.querySelectorAll('#send_textarea').length,
                tag: parsed.querySelector('#send_textarea')?.tagName || null };
            if (s.sourceInput.count !== 1 || s.sourceInput.tag !== 'TEXTAREA') {
                appHTML = null;
                throw new Error('读取的宿主页面缺少唯一的聊天输入框，已停止启动副窗口。请复制诊断。');
            }
            parsed.querySelectorAll('base').forEach(n => n.remove());
            const base = parsed.createElement('base'); base.href = host.location.href;
            const bootstrap = parsed.createElement('script');
            bootstrap.textContent = `(${childPrelude.toString()})(${JSON.stringify(id)},${JSON.stringify(avatar)},${JSON.stringify(host.location.href)},${s.existingHistory});`.replace(/<\/script/gi, '<\\/script');
            parsed.head.prepend(bootstrap); parsed.head.prepend(base);
            if (iosBrowser) {
                const reduced = parsed.createElement('style'); reduced.id = 'pt-ios-compositing';
                reduced.textContent = iosCompositingCSS;
                // Present before the first render; no repeated DOM/style polling.
                parsed.head.append(reduced);
            }
            const frame = element('iframe', 'pt-frame pt-hidden'); frame.title = `并行角色：${character.name}`;
            frame.name = `pt-${id}`; frame.id = `pt-frame-${id}`;
            frame.dataset.ptSessionId = id;
            frame.dataset.ttMobileSurface = 'viewport-host'; frame.setAttribute('aria-hidden', 'true');
            s.frame = frame;
            s.cleanups.push(() => frame.contentWindow?.__PT_SETTINGS_DISPOSE__?.());
            // A reload would fetch the original host HTML without our prelude.
            // Stop that session instead of letting an unisolated second app run.
            let guardedDocument = null;
            const navigationError = () => failChildSession(s, '副窗口发生了刷新或导航，已释放该窗口以防重复启动。请关闭此会话卡片后重新打开。', '副窗口导航已拦截');
            const checkDocument = () => {
                if (disposed || !sessions.has(id) || s.error || frame.dataset.ptBootWritten !== 'yes') return;
                try {
                    const w = frame.contentWindow;
                    if (w.__PT_CHILD_ID__ !== id || (guardedDocument && guardedDocument !== w.document)) return navigationError();
                    if (!guardedDocument) {
                        guardedDocument = w.document;
                        for (const clean of [w.__PT_BRIDGE_DISPOSE__, w.__PT_DIAGNOSTICS_STOP__]) if (typeof clean === 'function') s.cleanups.push(clean);
                        w.addEventListener('pagehide', navigationError, { once: true });
                        s.cleanups.push(() => w.removeEventListener('pagehide', navigationError));
                    }
                } catch { navigationError(); }
            };
            frame.addEventListener('load', checkDocument);
            s.cleanups.push(() => frame.removeEventListener('load', checkDocument));
            shell.append(frame);
            recordPageStage('初始化副窗口');
            layoutSessions(); sessionSizer?.observe(frame);
            // Unlike srcdoc, document.open() from the host realm gives this
            // document the actual app URL. TT and ST use location.origin/href.
            // Only the HTML fetched from this user's own host is evaluated.
            const writer = doc.createElement('script');
            const pageHTML = '<!DOCTYPE html>\n' + parsed.documentElement.outerHTML;
            // Only the child document boot requires a script in the host realm.
            // The launcher and script button no longer depend on inline injection.
            writer.textContent = `{
                const f = document.getElementById(${JSON.stringify(frame.id)});
                f.contentDocument.open();
                f.contentDocument.write(${JSON.stringify(pageHTML)});
                f.contentDocument.close();
                f.dataset.ptBootWritten = 'yes';
            }`;
            doc.head.append(writer); writer.remove();
            recordPageStage('副窗口页面已写入');
            if (frame.dataset.ptBootWritten !== 'yes') throw new Error('宿主阻止了子会话启动脚本。并行面板可用，但此环境暂不能打开并行会话。');
            checkDocument();
            if (s.error || !sessions.has(id) || disposed) return;
            const watch = host.setInterval(() => {
                if (s.ready || s.error || !sessions.has(id) || disposed) { host.clearInterval(watch); return; }
                try { attachChild(frame.contentWindow, id); revealStartupPopup(s); } catch {}
            }, 250);
            s.cleanups.push(() => host.clearInterval(watch));
            armLoadWarning(s);
        } catch (error) {
            failChildSession(s, error);
        }
    }

    function armLoadWarning(s) {
        host.clearTimeout(s.timeout);
        s.timeout = host.setTimeout(() => {
            if (!s.ready && !s.error && !s.needsConfirmation) {
                s.status = '加载较慢，仍在等待'; queueRender();
            }
        }, 60000);
    }
    function revealStartupPopup(s) {
        if (s.ready || s.error) return;
        const w = s.frame?.contentWindow;
        if (!w) return;
        // Display native dialogs for the user to decide; never click approval.
        const popup = w.document.querySelector('dialog[open]');
        if (popup) {
            if (!s.needsConfirmation) s.beforePopupPhase = s.phase;
            s.needsConfirmation = true; s.win = w;
            s.phase = '等待用户处理宿主弹窗'; s.status = '等待确认';
            host.clearTimeout(s.timeout);
            if (s.lastStartupPopup !== popup) {
                s.lastStartupPopup = popup;
                setActive(s.id);
            }
        } else if (s.needsConfirmation) {
            s.needsConfirmation = false; s.lastStartupPopup = null;
            s.phase = s.beforePopupPhase || '继续加载角色'; s.status = '正在载入…';
            armLoadWarning(s); queueRender();
        }
    }

    function attachChild(w, id) {
        const s = sessions.get(id);
        if (!s || s.error || s.frame?.contentWindow !== w) return false;
        if (s.attached) return true;
        if (!w.SillyTavern?.getContext) return false;
        try {
            const c = ctx(w), events = c.eventTypes || c.event_types;
            if (!c.eventSource?.on || !events || typeof c.selectCharacterById !== 'function') return false;
            s.win = w; s.phase = '已找到聊天上下文，等待 APP_READY';
            const ready = () => {
                // APP_READY may be replayed by hosts/extensions. Reserve before
                // scheduling so duplicate events cannot race character loading.
                if (s.openStarted || s.ready || s.error || !sessions.has(id) || disposed) return;
                s.openStarted = true;
                s.appReadyReceived = true;
                if (!s.error) s.status = '正在打开角色…';
                // Keep request diagnostics running through target chat loading.
                s.phase = 'APP_READY 已触发，正在打开目标角色';
                // Don't block native APP_READY dispatch with character navigation.
                host.setTimeout(async () => {
                    if (!sessions.has(id) || disposed || s.ready || s.error) return;
                    try {
                        const latest = ctx(w);
                        if (typeof latest.selectCharacterById !== 'function') throw new Error('当前版本缺少 selectCharacterById 接口');
                        const index = latest.characters.findIndex(c => c?.avatar === s.targetAvatar);
                        if (index < 0) throw new Error('子会话未找到目标角色');
                        // Older hosts ignore the chatFile option and read this
                        // field before loading the character's full card.
                        if (s.targetChat) latest.characters[index].chat = s.targetChat;
                        await latest.selectCharacterById(index, s.targetChat ? { chatFile: s.targetChat } : {});
                        const loaded = ctx(w);
                        if (loaded.characters[loaded.characterId]?.avatar !== s.targetAvatar) throw new Error('目标角色未成功打开，已保留原会话');
                        if (s.targetChat) {
                            const current = loaded.chatId || loaded.getCurrentChatId?.();
                            if (current !== s.targetChat) {
                                if (typeof loaded.openCharacterChat !== 'function') throw new Error('宿主缺少打开指定聊天记录的接口');
                                await loaded.openCharacterChat(s.targetChat);
                            }
                            const verified = ctx(w);
                            if ((verified.chatId || verified.getCurrentChatId?.()) !== s.targetChat) throw new Error('目标聊天记录未成功打开，请重试');
                        }
                        if (!sessions.has(id) || disposed || s.error) return;
                        if (s.existingHistory) {
                            const verified = ctx(w);
                            if (w.__PT_BOOT_TRACE__?.chatProtection?.blockedWrites) throw new Error('加载期间出现了写入历史记录的尝试，已拦截并停止副窗口。请复制诊断。');
                            if (!Array.isArray(verified.chat) || verified.chat.length === 0 || (s.expectedMessages > 2 && verified.chat.length < 2)) {
                                throw new Error('已有聊天未完整载入，已保持写入保护，未允许空白对话覆盖历史。请复制诊断。');
                            }
                        }
                        w.__PT_CHAT_WRITE_READY__ = true;
                        if (w.__PT_BOOT_TRACE__?.chatProtection) w.__PT_BOOT_TRACE__.chatProtection.verified = true;
                        w.__PT_BOOT_DONE__ = true;
                        w.__PT_DIAGNOSTIC_UNTIL__ = Date.now() + 30000;
                        s.needsConfirmation = false; s.lastStartupPopup = null;
                        s.ready = true; s.phase = '就绪'; s.status = '待命'; s.error = null;
                        host.clearTimeout(s.timeout); attachSession(s);
                        await s.profile?.ready;
                        if (!sessions.has(id) || disposed || s.error || !s.frame) return;
                        identity(s); setActive(id);
                        recordPageStage('副窗口就绪');
                        for (const seconds of [1, 3, 8, 15, 30]) {
                            const checkpoint = host.setTimeout(() => {
                                if (!disposed && sessions.get(id) === s) {
                                    recordPageStage(`副窗口就绪后 ${seconds} 秒`);
                                    if (seconds === 30) w.__PT_DIAGNOSTICS_STOP__?.();
                                }
                            }, seconds * 1000);
                            s.cleanups.push(() => host.clearTimeout(checkpoint));
                        }
                    } catch (error) { failChildSession(s, error, '目标聊天读取失败'); }
                }, 0);
            };
            on(c.eventSource, events.EXTENSION_SETTINGS_LOADED || 'extension_settings_loaded', () => {
                s.extensionsLoaded = true;
                if (iosBrowser) recordPageStage('副窗口扩展加载完成');
            }, s);
            on(c.eventSource, events.APP_INITIALIZED || 'app_initialized', () => { s.appInitializedReceived = true; s.phase = 'APP_INITIALIZED 已触发，等待启动收尾'; }, s);
            on(c.eventSource, events.APP_READY || 'app_ready', ready, s);
            s.attached = true; return true;
        } catch { s.phase = '聊天上下文尚未可用，等待重试'; return false; }
    }

    function reportChild(w, id, phase, issue) {
        const s = sessions.get(id);
        if (!s || s.frame?.contentWindow !== w) return;
        if (!issue) s.phase = String(phase).slice(0, 100);
        else {
            s.lastErrorPhase = String(phase).slice(0, 100);
            s.issues ||= [];
            if (s.issues.length < 15) s.issues.push(typeof issue === 'object' ? JSON.parse(JSON.stringify(issue)) : String(issue).slice(0, 100));
            if (iosBrowser && s.issues.length <= 3) recordPageStage('副窗口执行错误');
            if (!s.ready && issue?.kind === 'CHAT_INPUT_MISSING') {
                // Let the reporting script finish before disposing its document.
                host.setTimeout(() => failChildSession(s, 'TT 初始化时未找到有效聊天输入框，已释放副窗口。', '输入框初始化失败'), 0);
            } else if (!s.ready && issue?.kind === 'BOOT_DATA_INVALID') {
                host.setTimeout(() => failChildSession(s, '副窗口的启动设置或角色数据无效，已释放窗口。请刷新主页面角色列表后重试。', '副窗口启动数据无效'), 0);
            } else if (!s.ready && issue?.kind === 'CORE_SCRIPT_LOAD_FAILED') {
                host.setTimeout(() => failChildSession(s, '宿主聊天入口脚本加载失败，已释放副窗口。请关闭此会话卡片后重新打开。', '宿主入口加载失败'), 0);
            }
        }
    }
    function childState(s) {
        try {
            const w = s.frame?.contentWindow;
            if (!w) return null;
            const rect = s.frame.getBoundingClientRect();
            const computed = host.getComputedStyle(s.frame);
            return { documentReady: w.document.readyState, prelude: !!w.__PT_CHILD_ID__, tauriBridge: !!w.__TAURI__?.core?.invoke,
                hostABI: !!w.__TAURITAVERN__, sillyTavern: !!w.SillyTavern?.getContext,
                scriptCount: w.document.scripts.length, originMatches: w.location.origin === host.location.origin,
                input: w.__PT_INPUT_STATE__?.() || null,
                loading: bootSnapshot(w),
                boot: w.__PT_BOOT_TRACE__ ? { resourceErrors: w.__PT_BOOT_TRACE__.resourceErrors,
                    bridgeBytes: w.__PT_BOOT_TRACE__.bridgeBytes || null,
                    bridgeEvents: w.__PT_BOOT_TRACE__.bridgeEvents || null,
                    chatProtection: w.__PT_BOOT_TRACE__.chatProtection || null,
                    inputCompat: w.__PT_BOOT_TRACE__.inputCompat || null,
                    inputAtDOMContentLoaded: w.__PT_BOOT_TRACE__.inputAtDOMContentLoaded || null,
                    inputAtError: w.__PT_BOOT_TRACE__.inputAtError || null,
                    requests: w.__PT_BOOT_TRACE__.requests.map(r => ({ route: r.route, state: r.state, status: r.status ?? null, elapsedMs: r.elapsedMs ?? Date.now() - r.started })) } : null,
                view: { width: Math.round(rect.width), height: Math.round(rect.height), display: computed.display,
                    visibility: computed.visibility, hiddenClass: s.frame.classList.contains('pt-hidden'), inert: s.frame.inert,
                    containerWidth: Math.round(shell.getBoundingClientRect().width), containerHeight: Math.round(shell.getBoundingClientRect().height),
                    viewportWidth: Math.round(host.visualViewport?.width || host.innerWidth), viewportHeight: Math.round(host.visualViewport?.height || host.innerHeight) } };
        } catch { return { accessible: false }; }
    }
    function diagnostics() {
        return {
            script: 'Parallel Tavern', version: VERSION,
            host: host.__TAURITAVERN__ || host.__TAURI_RUNNING__ ? 'TauriTavern' : 'SillyTavern / browser',
            platformABI: host.__TAURITAVERN__?.abiVersion ?? null,
            hostAppVersion, cleanupErrors, mainErrors: { ...mainErrors },
            startupTiming: { ...startupTiming },
            diagnosticStorage: { ...diagnosticStorage }, lastParallelPageStage,
            lastParallelPageStageScope: 'same-origin; may belong to another tab; not proof of a crash',
            iosFixedLayer: iosBrowser, iosReducedCompositing: !!mainCompositingStyle, previousPageStage, currentPageStage,
            navigationType: host.performance?.getEntriesByType?.('navigation')?.[0]?.type || null,
            launcherVisible, enabled, appReady, activeSession: activeId, lastAction,
            sessions: [...sessions.values()].map(s => ({ id: s.id, ready: s.ready, busy: isBusy(s), generating: isGenerating(s), saving: isSaving(s), generationEventActive: !!s.busy, nativeGenerating: s.win?.__PT_CORE__?.is_send_press === true, status: s.status, error: s.error || null, hasCore: !!s.win?.__PT_CORE__, needsConfirmation: !!s.needsConfirmation, attached: !!s.attached, appInitializedReceived: !!s.appInitializedReceived, appReadyReceived: !!s.appReadyReceived, phase: s.phase || null, lastErrorPhase: s.lastErrorPhase || null, sourceInput: s.sourceInput || null, issues: s.issues || [], child: childState(s) })),
            // Deliberately exclude prompts, messages, names, URLs and credentials.
            userAgent: host.navigator.userAgent,
        };
    }
    async function exportDiagnostics() {
        const text = JSON.stringify(diagnostics(), null, 2);
        pickerOpen = true; panelOpen = true; picker.replaceChildren();
        const row = element('div', 'pt-row');
        row.append(element('span', 'pt-heading', '诊断信息'), button('返回', () => { pickerOpen = false; render(); }));
        const status = element('p', 'pt-muted', '正在复制到剪贴板…');
        const area = element('textarea'); area.id = 'pt-diagnostic-text'; area.readOnly = true; area.value = text;
        area.setAttribute('aria-label', '可手动复制的诊断信息');
        area.style.cssText = 'box-sizing:border-box;width:calc(100% - 40px);height:220px;background:#f5f0ee;color:#61505a;border:1px solid #e0d4d8;border-radius:12px;padding:10px;font:12px/1.5 monospace;user-select:text';
        const copy = async () => {
            try {
                if (!host.navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
                await host.navigator.clipboard.writeText(text);
                status.textContent = '已复制到剪贴板，可以直接粘贴发给我。';
            } catch {
                area.focus(); area.select();
                let ok = false; try { ok = doc.execCommand('copy'); } catch {}
                status.textContent = ok ? '已复制到剪贴板，可以直接粘贴发给我。' : '自动复制未成功。请在下方长按全选复制，或按 Ctrl+C。';
            }
        };
        picker.append(row, status, area, button('再次复制', copy));
        render(); await copy();
    }
    function dispose() {
        if ([...sessions.values()].some(s => s.id !== 'main' && isBusy(s))) { notify('子会话仍在运行，请先停止或等待完成再卸载。'); return false; }
        disposed = true;
        for (const s of sessions.values()) {
            if (s.id === 'main') { host.clearTimeout(s.timeout); runCleanups(s.cleanups); }
            else releaseChild(s);
        }
        sessions.clear();
        runCleanups(teardown);
        host.clearTimeout(toastTimer);
        for (const e of [style, shell, launcher, panel, picker, toast, completionBadge]) e.remove();
        delete host[KEY]; return true;
    }
    host[KEY] = {
        version: VERSION, owner, claim: token => { host[KEY].owner = token; disposeRequested = false; },
        show: () => {
            recordPageStage('打开悬浮面板');
            // QR is also a recovery entrance for stale/offscreen mobile coordinates.
            for (const node of [launcher, panel]) {
                delete node.dataset.ptDragged;
                for (const property of ['top', 'left', 'right', 'bottom', 'max-height', 'max-width']) node.style.removeProperty(property);
            }
            panelOpen = true; render(); keepFloatingVisible();
            host.requestAnimationFrame(() => {
                if (disposed || !panelOpen) return;
                if (panel.getBoundingClientRect().height < 20 || launcher.getBoundingClientRect().width < 20) {
                    for (const node of [launcher, panel]) { node.dataset.ptFixedFallback = 'true'; node.removeAttribute('popover'); setFloating(node, true); }
                    keepFloatingVisible();
                    if (panel.getBoundingClientRect().height < 20) host.alert(`并行对话 v${VERSION}：脚本已启动，但手机界面被隐藏。请反馈 TT 版本和手机系统。\n${host.navigator.userAgent}`);
                }
            });
        }, attachChild, reportChild, diagnostics, dispose,
        setNightMode,
        getActiveWindow: () => sessions.get(activeId)?.win || host,
        setLauncherVisible: value => {
            launcherVisible = value !== false;
            if (!launcherVisible) { panelOpen = false; pickerOpen = false; }
            render();
        },
        requestDispose: () => {
            disposeRequested = true;
            if (![...sessions.values()].some(s => s.id !== 'main' && isBusy(s))) dispose();
            else notify('脚本已停用，将在现有生成结束后移除并行界面。');
        },
    };
    attachSession(main);
    const events = ctx(host).eventTypes || ctx(host).event_types;
    on(ctx(host).eventSource, events.APP_READY || 'app_ready', () => { appReady = true; queueRender(); }, main);
    const refresh = host.setInterval(() => {
        if (disposeRequested && ![...sessions.values()].some(s => s.id !== 'main' && isBusy(s))) { dispose(); return; }
        refreshLiveStatus();
    }, 1000);
    teardown.push(() => host.clearInterval(refresh));
    const unload = event => {
        if ([...sessions.values()].some(isBusy)) { event.preventDefault(); event.returnValue = ''; }
    };
    host.addEventListener('beforeunload', unload);
    const visibilityChanged = () => recordPageStage(doc.visibilityState === 'hidden' ? '页面转入后台' : '页面回到前台');
    doc.addEventListener('visibilitychange', visibilityChanged);
    teardown.push(() => doc.removeEventListener('visibilitychange', visibilityChanged));
    const leaving = event => {
        currentPageStage = { ...currentPageStage, pageExitObserved: true, pageExitTime: Date.now(), persisted: !!event.persisted };
        persistStage();
    };
    const resumed = event => {
        if (!event.persisted) return;
        currentPageStage = { ...currentPageStage, pageExitObserved: false, pageExitTime: null, persisted: false };
        recordPageStage('页面从缓存恢复');
    };
    host.addEventListener('pageshow', resumed);
    teardown.push(() => host.removeEventListener('pageshow', resumed));
    host.addEventListener('pagehide', leaving, true);
    teardown.push(() => host.removeEventListener('pagehide', leaving, true));
    teardown.push(() => host.removeEventListener('beforeunload', unload));
    render();
    }
})();
