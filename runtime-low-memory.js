/* 并行对话 0.7.0-unified-r3 — 低内存单页面后台生成（基于 0.6.8-r7）。
 *
 * 不再为每个会话启动第二个酒馆页面（iframe）。切换对话时，只把正在进行的
 * 生成请求留在后台继续接收；切回该对话后，由酒馆原生流程把保存下来的响应
 * 重新走一遍（正则、变量脚本、保存都是原生逻辑）。不自行拼接提示词，不直接
 * 写聊天文件，不保存 API 密钥。
 */
const VERSION = '0.7.0-unified-r3';
const KEY = '__PARALLEL_TAVERN_V2__';
const MAX_SESSIONS = 3;
const STORE = 'parallel-tavern.jobs.v1';
const STORE_LIMIT = 1500000;
const GEN_URL = /\/api\/(?:backends\/(?:chat-completions|text-completions|kobold)\/generate|novelai\/generate(?:-stream)?)(?:[?#]|$)/;
const TYPES = ['normal', 'regenerate', 'swipe', 'continue'];
const NULL_BODY = [101, 204, 205, 304];

// ---------------------------------------------------------------------------
// 响应解析：只用于面板预览、复制文本，以及接口类型改变后的兜底转码。
// 正常切回时直接回放原始字节，由酒馆自己解析。
// ---------------------------------------------------------------------------
const asText = value => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : (part?.type === 'text' || part?.text) && !part.thought ? part.text || '' : '').join('') : '';
function pick(data, out) {
    if (!data || typeof data !== 'object') return;
    const choice = data.choices?.[0];
    const parts = data.candidates?.[0]?.content?.parts;
    out.text += asText(choice?.delta?.content ?? choice?.message?.content ?? choice?.text)
        || (typeof data.delta?.text === 'string' ? data.delta.text : '')
        || (Array.isArray(parts) ? parts.filter(p => !p.thought).map(p => p.text || '').join('') : '')
        || (Array.isArray(data.content) ? data.content.filter(p => p?.type === 'text').map(p => p.text || '').join('') : '')
        || asText(data.results?.[0]?.text ?? data.token ?? data.output ?? data.response ?? (typeof data.content === 'string' ? data.content : ''))
        || (typeof data.text === 'string' ? data.text : '');
    out.reasoning += asText(choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? choice?.message?.reasoning_content ?? choice?.message?.reasoning)
        || (typeof data.delta?.thinking === 'string' ? data.delta.thinking : '')
        || (Array.isArray(parts) ? parts.filter(p => p.thought).map(p => p.text || '').join('') : '');
}
function parseBody(body) {
    const out = { text: '', reasoning: '' };
    if (/^\s*[[{"]/.test(body)) {
        try { const data = JSON.parse(body); if (typeof data === 'string') out.text = data; else pick(data, out); return out; } catch { /* 可能是被截断的流 */ }
    }
    for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { pick(JSON.parse(payload), out); } catch { /* 不完整的最后一行 */ }
    }
    return out;
}
// 同时带上各家接口的字段，酒馆按当前接口类型取其中一种。
function reencode({ text, reasoning }, stream) {
    if (!stream) {
        return JSON.stringify({
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, text }],
            content: [{ type: 'text', text }], results: [{ text }], output: text,
        });
    }
    const chunk = (t, r) => 'data: ' + JSON.stringify({
        type: 'content_block_delta', token: t,
        choices: [{ index: 0, text: t, delta: { content: t, ...(r ? { reasoning_content: r } : {}) } }],
        delta: r ? { type: 'thinking_delta', thinking: r } : { type: 'text_delta', text: t },
        candidates: [{ content: { parts: [r ? { text: r, thought: true } : { text: t }] } }],
    }) + '\n\n';
    return (reasoning ? chunk('', reasoning) : '') + chunk(text, '') + 'data: [DONE]\n\n';
}
function signature(input, init) {
    let path = '';
    try { path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname; } catch { /* keep empty */ }
    const sig = { path, src: '', stream: false };
    try {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body) { sig.src = String(body.chat_completion_source || body.api_type || ''); sig.stream = body.stream === true || body.streaming === true; sig.model = typeof body.model === 'string' ? body.model : ''; }
    } catch { /* 非 JSON 请求体按原样处理 */ }
    if (/generate-stream/.test(path)) sig.stream = true;
    return sig;
}

export function start({ settings, save, installProfiles, nativeBusy, nativeSaving, nativeCore, regexEngine }) {
    const host = window, doc = document;
    if (host[KEY]) return host[KEY];
    const ctx = () => host.SillyTavern.getContext();
    const emitter = ctx().eventSource;
    const events = ctx().eventTypes || ctx().event_types || {};
    const teardown = [];
    const encoder = new TextEncoder();
    let disposed = false;
    const timers = new Set(), sleepResolvers = new Set();
    function later(fn, ms = 0) {
        if (disposed) return null;
        const id = host.setTimeout(() => { timers.delete(id); if (!disposed) fn(); }, ms);
        timers.add(id); return id;
    }
    function cancelLater(id) { host.clearTimeout(id); timers.delete(id); }
    const delay = ms => new Promise(resolve => {
        if (disposed) { resolve(); return; }
        sleepResolvers.add(resolve);
        later(() => { sleepResolvers.delete(resolve); resolve(); }, ms);
    });
    async function waitFor(test, timeout, step = 50) {
        const end = Date.now() + timeout;
        while (!disposed && Date.now() < end) { if (test()) return true; await delay(step); }
        return !disposed && test();
    }



    // ----- 状态 -----
    const sessions = new Map();   // key -> { key, avatar, name, chatId, job, unread, touched }
    const jobs = new Map();       // id  -> job
    let curKey = null;
    let gen = null;               // 最近一次原生生成的类型与所在对话
    let quietPending = 0;
    let armed = null;             // 下一条生成请求由本扩展接管
    let replayArm = null;         // 切回后等待原生流程发起的那次请求
    let switching = false, pendingSwitch = null, reattachBusy = false, reattachTimer = null;
    let profile = null;
    // 并行开关：关闭时本扩展不接管任何请求、不建会话、不动草稿和滚动，就是普通聊天。
    const isOn = () => settings.parallelEnabled === true;
    let switchingSince = 0;
    let fullLoggedFor = null;
    let building = null;          // 原生生成已开始、请求尚未发出
    let lastGenStart = 0, dryActiveUntil = 0, sendIntentAt = 0;
    let fgFinishedKey = null, lastStoppedAt = 0;   // 前台生成刚结束（侧边小条显示绿色用）
    const finalizedMessages = new WeakSet();
    const nativeSaveFailures = new Map();
    const nativeSaveChains = new Map(), nativeSaveSequence = new Map();
    const drafts = new Map();                       // 每个会话各自的未发送草稿
    let storageStatus = { state: 'empty', omitted: 0 };
    // 后台写入聊天文件
    let bgBlocked = null;                      // 本次页面内判定“这台宿主不支持后台写入”的原因
    let bgChain = Promise.resolve(), bgActive = 0, bgFailures = 0;
    let hideTimer = null;
    let chatSeenAt = 0;                        // 最近一次发现“当前聊天变了”的时间
    let navIntentAt = 0;                       // 最近一次点了聊天区以外的地方（可能是在换聊天）
    const hideStyle = document.createElement('style');
    hideStyle.id = 'pt-pending-reply-style';
    document.head.append(hideStyle);

    // ----- 诊断记录：只记步骤、状态和报错位置，不记聊天内容、角色名或密钥 -----
    const startedAt = Date.now();
    const logs = [], errors = [];
    const ids = new Map();
    const sid = key => { if (!key) return '-'; if (!ids.has(key)) ids.set(key, 'S' + (ids.size + 1)); return ids.get(key); };
    function log(step, detail) {
        logs.push(detail === undefined ? [Date.now() - startedAt, step] : [Date.now() - startedAt, step, detail]);
        if (logs.length > 150) logs.shift();
    }
    function logError(where, error) {
        const stack = String(error?.stack || '').split('\n').slice(1, 4).map(line => line.trim().replace(/https?:\/\/[^/]+\//g, '').slice(0, 120));
        errors.push({ at: Date.now() - startedAt, where, name: String(error?.name || 'Error'), message: String(error?.message || error).slice(0, 200), stack });
        if (errors.length > 12) errors.shift();
        log('error', where);
    }
    const onWindowError = event => { if (/parallel|runtime\.js/i.test(String(event.filename || event.error?.stack || ''))) logError('window', event.error || event.message); };
    const onRejection = event => { if (/runtime\.js|character-profiles\.js/.test(String(event.reason?.stack || ''))) logError('promise', event.reason); };
    host.addEventListener('error', onWindowError);
    host.addEventListener('unhandledrejection', onRejection);
    teardown.push(() => { host.removeEventListener('error', onWindowError); host.removeEventListener('unhandledrejection', onRejection); });
    const withTimeout = (promise, ms, label) => {
        let timer;
        return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = later(() => reject(new Error(label + '超时')), ms); })])
            .finally(() => cancelLater(timer));
    };

    function on(name, fn) {
        if (!name || !emitter?.on) return;
        emitter.on(name, fn);
        teardown.push(() => emitter.removeListener ? emitter.removeListener(name, fn) : emitter.off?.(name, fn));
    }
    function current() {
        try {
            const c = ctx();
            if (c.groupId) return { key: null, group: true };
            const character = c.characters?.[c.characterId];
            const chatId = c.chatId ?? c.getCurrentChatId?.();
            if (!character?.avatar || !chatId) return { key: null };
            return { key: `${character.avatar}\n${chatId}`, avatar: character.avatar, name: character.name, chatId: String(chatId) };
        } catch { return { key: null }; }
    }
    // 酒馆自己的“正在生成”标志。发出消息到请求真正发出之间（组装提示词，手机上可能好几秒）
    // 界面上还看不出在生成，但酒馆此时会拒绝切换聊天，所以必须读这个标志而不是只看停止按钮。
    function pressFlag() {
        try { const value = nativeBusy?.(); return typeof value === 'boolean' ? value : null; } catch { return null; }
    }
    function domGenerating() {
        if (doc.body.dataset.generating === 'true') return true;
        const stop = doc.getElementById('mes_stop');
        return !!stop && host.getComputedStyle(stop).display !== 'none';
    }
    // 生成已开始但酒馆的忙碌标志还没立起来（它要先跑事件、连通性检查），这一小段也算忙。
    function buildingNow() {
        if (!building) return false;
        const age = Date.now() - building.since, flag = pressFlag();
        const valid = flag === true ? age < 120000 : flag === false ? age < 3000 : age < 20000;
        if (!valid) building = null;
        return valid;
    }
    const isGenerating = () => pressFlag() === true || domGenerating() || buildingNow();
    function unstick(reason) {
        log('unstick', { reason, ...genState() });
        try { ctx().stopGeneration(); } catch { /* ignore */ }
        try { ctx().activateSendButtons?.(); } catch { /* ignore */ }
    }
    function genState() {
        const stop = doc.getElementById('mes_stop');
        return { press: pressFlag(), building: building ? Date.now() - building.since : null, gen: doc.body.dataset.generating ?? null, stop: stop ? host.getComputedStyle(stop).display : 'missing', swiping: doc.body.dataset.swiping ?? null };
    }
    // 滑动生成被中断后，酒馆还要把滑动状态收尾；这期间不能切换聊天。
    const isSwiping = () => doc.body.dataset.swiping === 'true';
    // Some hosts release the send button before streamed-message hooks and the
    // final save finish. The processor is cleared only after those steps return.
    const nativeStream = () => { try { return ctx().streamingProcessor || null; } catch { return null; } };
    const foregroundJob = () => [...jobs.values()].find(job => job.attached) || null;
    function ensureSession(info) {
        let session = sessions.get(info.key);
        if (!session) {
            // 满了就不再加卡，也绝不自动挤掉已有的卡；只有用户手动“关闭会话”才会腾出位置。
            if (sessions.size >= MAX_SESSIONS) { if (fullLoggedFor !== info.key) { fullLoggedFor = info.key; log('session:full'); } return null; }
            session = { key: info.key, avatar: info.avatar, name: info.name, chatId: info.chatId, job: null, unread: false, touched: 0 };
            sessions.set(info.key, session);
            log('session:add', { s: sid(info.key), total: sessions.size });
        }
        session.name = info.name || session.name; session.touched = Date.now();
        return session;
    }
    function syncCurrent() {
        const info = current();
        curKey = info.key;
        // 切换途中酒馆可能先短暂打开该角色的另一份聊天，那不是用户要的会话，不建卡。
        if (info.key && !switching && isOn()) ensureSession(info);
    }

    // ----- 后台任务 -----
    // Decode only newly received chunks. Previously every preview copied the
    // entire byte buffer and reparsed the entire stream once per second.
    function bodyText(job) {
        job.bodyDecoder ||= new TextDecoder();
        job.bodyChunkIndex ||= 0;
        job.decoded ||= '';
        while (job.bodyChunkIndex < job.chunks.length) {
            job.decoded += job.bodyDecoder.decode(job.chunks[job.bodyChunkIndex++], { stream: true });
        }
        if (job.status !== 'running' && !job.bodyFlushed) {
            job.decoded += job.bodyDecoder.decode(); job.bodyFlushed = true;
        }
        job.decodedAt = job.bytes;
        return job.decoded;
    }
    function parsed(job) {
        if (job.head?.status >= 400) return { text: '', reasoning: '' };
        if (!job.previewFormat && job.chunks.length) {
            const first = new TextDecoder().decode(job.chunks[0]).trimStart();
            if (first) job.previewFormat = /^[[{"]/.test(first) ? 'json' : 'stream';
        }
        if (job.previewFormat === 'json' || (!job.sig?.stream && !/event-stream/i.test(job.head?.type || ''))) {
            if (job.parsedAt !== job.bytes || !job.parsed) { job.parsed = parseBody(bodyText(job)); job.parsedAt = job.bytes; }
            return job.parsed;
        }
        const state = job.previewState ||= { decoder: new TextDecoder(), index: 0, pending: '', out: { text: '', reasoning: '' } };
        const consume = line => {
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            try { pick(JSON.parse(payload), state.out); } catch { /* incomplete/malformed event */ }
        };
        while (state.index < job.chunks.length) {
            state.pending += state.decoder.decode(job.chunks[state.index++], { stream: true });
            let end;
            while ((end = state.pending.indexOf('\n')) >= 0) {
                consume(state.pending.slice(0, end).replace(/\r$/, ''));
                state.pending = state.pending.slice(end + 1);
            }
        }
        if (job.status !== 'running' && !state.flushed) {
            state.pending += state.decoder.decode(); consume(state.pending); state.pending = ''; state.flushed = true;
        }
        if (job.status !== 'running' && !state.out.text && !state.out.reasoning) {
            const body = bodyText(job);
            if (/^\s*[[{"]/.test(body)) return job.parsed ||= parseBody(body);
        }
        return state.out;
    }
    // 这次后台请求是否以失败告终。酒馆的后端常把上游错误包成“HTTP 200 + error 字段”，所以不能只看状态码。
    function jobError(job) {
        if (!job || job.status === 'running') return null;
        if (job.failure) return String(job.failure.message || job.failure).slice(0, 160) || '请求失败';
        if (job.head?.status >= 400) return `HTTP ${job.head.status}`;
        if (job.errorChecked === job.bytes) return job.errorText;
        let text = null;
        try {
            const body = bodyText(job);
            // TauriTavern 把上游错误包装成一条正文为“[API 错误]…”的普通回复，用它特有的 id 识别。
            if (/"id"\s*:\s*"tauritavern-error/.test(body.slice(0, 600))) {
                text = String(parsed(job).text || '').replace(/^\s*\[[^\]]*\]\s*/, '').slice(0, 160) || '接口返回了错误';
            } else if (/^\s*\{/.test(body)) {
                const data = JSON.parse(body);
                if (data?.error) text = String(data.error?.message || data.message || data.response || (typeof data.error === 'string' ? data.error : '') || '接口返回了错误').slice(0, 160);
            }
            if (!text && job.bytes > 0) { const got = parsed(job); if (!got.text && !got.reasoning) text = '接口没有返回内容'; }
        } catch { /* 解析不了就当作正常内容交给原生流程 */ }
        job.errorChecked = job.bytes; job.errorText = text;
        return text;
    }
    function persist() {
        try {
            const list = [];
            let size = 0, omitted = 0;
            for (const job of jobs.values()) {
                if ((job.attached && !job.saveFailed && !job.awaitingNativeSave) || job.status === 'running' || !job.head) continue;
                // 已经写进聊天文件的回复不必再在本机存一份全文，只留一条记录用来显示“待查看”。
                const body = job.bgWritten ? '' : bodyText(job);
                if (size + body.length > STORE_LIMIT) { omitted++; continue; }
                size += body.length;
                list.push({ id: job.id, key: job.key, avatar: job.avatar, name: job.name, chatId: job.chatId, type: job.type, sig: job.sig,
                    head: job.head, created: job.created, saveFailed: !!job.saveFailed, awaitingNativeSave: !!job.awaitingNativeSave, baseLength: job.baseLength, cont: job.bgWritten ? null : job.cont, regenOld: job.regenOld, swipeIndex: job.swipeIndex, finishedAt: job.finishedAt, truncated: !!job.truncated, bgWritten: !!job.bgWritten, bgIndex: job.bgIndex, startedAt: job.startedAt, body });
            }
            if (list.length) host.localStorage.setItem(STORE, JSON.stringify(list));
            else host.localStorage.removeItem(STORE);
            storageStatus = { state: omitted ? 'limited' : list.length ? 'saved' : 'empty', omitted };
        } catch {
            storageStatus = { state: 'failed', omitted: 0 };
        }
        // Keep this warning in the panel so a completion toast cannot hide it.
        if (storageStatus.state === 'limited' || storageStatus.state === 'failed') queueRender();
    }
    function restore() {
        try {
            const list = JSON.parse(host.localStorage.getItem(STORE) || '[]');
            for (const item of Array.isArray(list) ? list : []) {
                if (!item?.id || !item.key || !item.head || typeof item.body !== 'string' || sessions.size >= MAX_SESSIONS) continue;
                const chunk = encoder.encode(item.body);
                const job = { ...item, status: 'done', chunks: [chunk], bytes: chunk.byteLength, attached: false, detaching: false, front: null, ac: new AbortController(), restored: true };
                delete job.body;
                jobs.set(job.id, job);
                sessions.set(job.key, { key: job.key, avatar: job.avatar, name: job.name, chatId: job.chatId, job, unread: true, touched: job.finishedAt || 0 });
            }
        } catch { /* 损坏的记录直接忽略 */ }
    }
    function drop(job, { abort = false } = {}) {
        if (abort && job.status === 'running') { job.status = 'stopped'; try { job.ac.abort(); } catch { /* already finished */ } }
        jobs.delete(job.id);
        const session = sessions.get(job.key);
        if (session?.job === job) { session.job = null; session.unread = false; }
        if (replayArm?.job === job) releaseReplay();
        persist(); queueRender();
    }
    function settle() {
        if (isGenerating() || nativeStream() || nativeSaving?.() === true) return;
        for (const job of [...jobs.values()]) {
            if (job.attached && !job.detaching && !job.pendingDetach && job.status !== 'running' && !job.saveFailed && !job.awaitingNativeSave) drop(job);
        }
    }
    function finish(job, error) {
        if (job.status === 'running') job.status = 'done';
        job.finishedAt = Date.now();
        log('job:finish', { s: sid(job.key), status: job.status, http: job.head?.status ?? null, bytes: job.bytes, attached: job.attached, error: error ? String(error.name || 'Error') : null });
        const front = job.front; job.front = null;
        if (front) { try { error ? front.error(error) : front.close(); } catch { /* 原生端已取消读取 */ } }
        if (error && !job.head) { job.failure = error; job.onFail?.(error); }
        else if (error) job.truncated = true;
        if (disposed) return;
        if (job.saveFailed) persist();
        if (job.status === 'stopped' && !job.keepPartial) { drop(job); return; }
        if (!job.attached && !job.detaching) announce(job);
        queueRender(); later(settle, 300);
    }
    function announce(job) {
        const session = sessions.get(job.key);
        if (!session || session.job !== job) return;
        persist();
        if (job.key === curKey && !switching) { scheduleReattach(50); return; }
        session.unread = true;
        pumpBgWrites();
        if (switching) return;
        completionSound();
        notify(jobError(job) ? `${job.name} 的后台生成失败，切回可查看原因。` : `${job.name} 的回复已完成，可以切回查看。`);
    }
    function pump(job, request) {
        request.then(async response => {
            job.head = { status: response.status, statusText: response.statusText, type: response.headers.get('content-type') || 'application/json' };
            job.onHead?.();
            const add = value => {
                if (!value?.byteLength || job.status !== 'running') return;
                job.chunks.push(value); job.bytes += value.byteLength;
                if (job.front) { try { job.front.enqueue(value.slice()); } catch { job.front = null; } }
            };
            if (NULL_BODY.includes(response.status)) { /* no body */ }
            else if (response.body?.getReader) {
                const reader = response.body.getReader();
                for (;;) { const { done, value } = await reader.read(); if (done) break; add(value); }
            } else add(new Uint8Array(await response.arrayBuffer()));
            finish(job);
        }).catch(error => finish(job, error));
    }
    function buildResponse(job, bytes = null) {
        const head = job.head;
        const init = { status: head.status >= 200 && head.status <= 599 ? head.status : 200, statusText: head.statusText || '', headers: { 'Content-Type': bytes ? (job.replaySig?.stream ? 'text/event-stream' : 'application/json') : head.type } };
        if (NULL_BODY.includes(init.status)) return new host.Response(null, init);
        if (bytes) return new host.Response(bytes, { ...init, status: 200 });
        let controller;
        const body = new host.ReadableStream({
            start(c) {
                controller = c;
                for (const chunk of job.chunks) c.enqueue(chunk.slice());
                if (job.status !== 'running') c.close(); else job.front = c;
            },
            cancel() { if (job.front === controller) job.front = null; },
        });
        return new host.Response(body, init);
    }
    // 交给酒馆的那一端：它的中止信号只在“不是转入后台”时才真正取消网络请求。
    function serve(job, signal, makeResponse) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const abortError = () => new host.DOMException('The operation was aborted.', 'AbortError');
            const onAbort = () => {
                signal?.removeEventListener('abort', onAbort);
                const userStop = !job.detaching;
                if (userStop && job.status === 'running') {
                    job.keepPartial = job.bytes > 0; job.awaitingNativeSave = job.keepPartial;
                    job.status = 'stopped'; try { job.ac.abort(); } catch { /* ignore */ }
                }
                const front = job.front; job.front = null;
                try { front?.error(abortError()); } catch { /* already closed */ }
                if (!settled) { settled = true; reject(abortError()); }
                if (userStop) { later(() => { if (jobs.has(job.id) && job.status !== 'running' && !job.keepPartial) drop(job); }, 0); }
            };
            if (signal?.aborted) { onAbort(); return; }
            signal?.addEventListener('abort', onAbort);
            const deliver = () => {
                if (settled) return;
                settled = true;
                try { resolve(makeResponse()); } catch (error) { reject(error); }
            };
            job.onFail = error => { if (!settled) { settled = true; reject(error); } };
            if (job.failure && !job.head) { job.onFail(job.failure); return; }
            job.onHead = deliver;
            if (job.head) deliver();
        });
    }
    function intercept(arm, input, init) {
        const signal = init?.signal || (typeof input === 'object' ? input.signal : null);
        const sig = signature(input, init);
        log(arm.replay ? 'fetch:replay' : 'fetch:track', { src: sig.src, stream: sig.stream, builtMs: building ? Date.now() - building.since : null });
        building = null;
        if (arm.replay) return replay(arm.replay, sig, signal);
        // The host has already built this request. Validate ownership/readiness
        // without changing the settings used to construct its body.
        try { profile?.prepareSend?.({ stage: 'request' }); } catch (error) { building = null; throw error; }
        for (const old of [...jobs.values()]) if (old.attached && old.status !== 'running') drop(old);
        const info = arm.gen.info;
        if (current().key !== info.key) throw new Error('生成请求所属聊天已改变，已阻止发送');
        const session = ensureSession(info);
        if (!session || session.job) return nativeFetch.call(host, input, init);
        const job = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, key: info.key, avatar: info.avatar, name: info.name, chatId: info.chatId,
            type: arm.gen.type, cont: arm.gen.cont, sig, status: 'running', chunks: [], bytes: 0, head: null, attached: true, detaching: false, front: null,
            ac: new AbortController(), baseLength: ctx().chat.length, created: false, startedAt: Date.now() };
        if (job.type === 'regenerate') job.regenOld = arm.gen.regenOld || null;
        // 滑动生成：此刻 swipe_id 指向即将生成的那一格。
        if (job.type === 'swipe') job.swipeIndex = Number(ctx().chat[job.baseLength - 1]?.swipe_id) || 0;
        jobs.set(job.id, job); session.job = job; session.unread = false;
        let request;
        try { request = nativeFetch.call(host, input, { ...(init || {}), signal: job.ac.signal }); }
        catch (error) { drop(job); throw error; }
        pump(job, request); queueRender();
        return serve(job, signal, () => buildResponse(job));
    }
    function replay(job, sig, signal) {
        if (current().key !== job.key) throw new Error('回复所属聊天已改变，已阻止回放');
        releaseReplay();
        job.attached = true; job.replaySig = sig;
        const session = sessions.get(job.key); if (session) session.unread = false;
        queueRender();
        const same = !job.head || job.head.status >= 400 || (job.sig.path === sig.path && job.sig.src === sig.src && job.sig.stream === sig.stream);
        if (same) return serve(job, signal, () => buildResponse(job));
        // 接口类型或流式开关与发起时不同：等完整结果后转成当前接口能读的格式。
        return waitFor(() => job.status !== 'running' || !!signal?.aborted, 3600000, 200)
            .then(() => serve(job, signal, () => buildResponse(job, encoder.encode(reencode(parsed(job), sig.stream)))));
    }
    function releaseReplay() {
        const arm = replayArm; replayArm = null;
        if (!arm) return;
        host.clearInterval(arm.watch);
        if (arm.draft) {
            const input = doc.getElementById('send_textarea');
            const merge = value => !value || value === arm.draft ? arm.draft : arm.draft + '\n' + value;
            if (current().key !== arm.job.key) { drafts.set(arm.job.key, merge(drafts.get(arm.job.key))); return; }
            if (input) { input.value = merge(input.value); input.dispatchEvent(new host.Event('input', { bubbles: true })); }
        }
    }

    // ----- 阅读位置：切走时记住读到哪一楼，切回后恢复 -----
    const readings = new Map();   // key -> { bottom } | { mesid, offset }
    let restoringUntil = 0, readingTimer = null, cancelRestore = () => {};
    const scroller = () => doc.getElementById('chat');
    function recordReading() {
        if (disposed || Date.now() < restoringUntil || !curKey) return;
        const el = scroller();
        // 聊天正在清空或加载另一份时不记录，避免把旧位置覆盖掉。
        if (!el || current().key !== curKey) return;
        const nodes = el.querySelectorAll('.mes[mesid]');
        if (!nodes.length) return;
        readings.delete(curKey);
        if (el.scrollHeight - el.clientHeight - el.scrollTop < 8) { readings.set(curKey, { bottom: true }); }
        else {
            const top = el.getBoundingClientRect().top + el.clientTop;
            for (const node of nodes) {
                const r = node.getBoundingClientRect();
                if (r.bottom > top && r.height > 0) { readings.set(curKey, { bottom: false, mesid: node.getAttribute('mesid'), offset: r.top - top }); break; }
            }
        }
        if (readings.size > 40) readings.delete(readings.keys().next().value);
    }
    const onChatScroll = () => { if (readingTimer === null) readingTimer = later(() => { readingTimer = null; recordReading(); }, 150); };
    scroller()?.addEventListener('scroll', onChatScroll, { passive: true });
    // 点聊天区以外的任何东西（角色列表、历史记录、关闭聊天…）之前先记一次，不依赖滚动事件。
    const onOutsideClick = event => { if (!event.target?.closest?.('#chat')) { navIntentAt = Date.now(); recordReading(); } };
    doc.addEventListener('click', onOutsideClick, true);
    teardown.push(() => { scroller()?.removeEventListener('scroll', onChatScroll); doc.removeEventListener('click', onOutsideClick, true); cancelLater(readingTimer); cancelRestore(); });
    const pendingWrite = key => { const job = sessions.get(key)?.job; return !!job && !job.mismatch; };
    function restoreReading(key) {
        cancelRestore();
        const saved = key && readings.get(key);
        // 有后台回复要写回时不恢复，让酒馆自己滚到新回复。
        if (!saved || saved.bottom || saved.mesid == null || pendingWrite(key)) return;
        restoringUntil = Date.now() + 1600;
        let cancelled = false;
        const timers = [], inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
        const cancel = () => {
            if (cancelled) return;
            cancelled = true; restoringUntil = 0;
            timers.forEach(id => cancelLater(id));
            for (const name of inputs) host.removeEventListener(name, cancel, true);
        };
        for (const name of inputs) host.addEventListener(name, cancel, { capture: true, passive: true });
        const apply = () => {
            if (cancelled || curKey !== key || pendingWrite(key)) return;
            const el = scroller();
            const anchor = el && [...el.querySelectorAll('.mes[mesid]')].find(node => node.getAttribute('mesid') === saved.mesid);
            if (!anchor) return;
            const top = el.getBoundingClientRect().top + el.clientTop;
            const delta = anchor.getBoundingClientRect().top - top - saved.offset;
            if (Math.abs(delta) > 1) el.scrollTop += delta;
        };
        // 酒馆加载完会滚到底，图片加载还会改变高度：短时间内多校正几次，用户一操作就停。
        for (const ms of [0, 120, 350, 800, 1400]) timers.push(later(apply, ms));
        timers.push(later(cancel, 1600));
        cancelRestore = cancel;
    }

    const nativeFetch = host.fetch;
    function parallelFetch(input, init) {
        let saveKey = null;
        try {
            const url = new URL(typeof input === 'string' ? input : input?.url || String(input), host.location.href);
            if (/\/api\/chats\/(save|save-metadata)$/.test(url.pathname) && String(init?.method || input?.method || 'GET').toUpperCase() === 'POST') {
                saveKey = current().key;
                if (typeof init?.body === 'string') {
                    try { const body = JSON.parse(init.body); if (typeof body.avatar_url === 'string' && typeof body.file_name === 'string') saveKey = body.avatar_url + '\n' + body.file_name; } catch { /* compressed body uses native current-chat snapshot */ }
                }
            }
        } catch { /* no route */ }
        if (saveKey && !disposed) {
            const sequence = (nativeSaveSequence.get(saveKey) || 0) + 1;
            nativeSaveSequence.set(saveKey, sequence);
            const owner = sessions.get(saveKey)?.job;
            const note = error => {
                if (nativeSaveSequence.get(saveKey) !== sequence) return;
                const job = sessions.get(saveKey)?.job === owner ? owner : null;
                if (error) {
                    nativeSaveFailures.set(saveKey, error);
                    if (job) {
                        job.saveFailed = true;
                        if (current().key === saveKey) {
                            const chat = ctx().chat, last = chat[chat.length - 1];
                            if (last && !last.is_user && (job.type === 'continue' || job.type === 'swipe' || chat.length > job.baseLength)) { (last.extra ||= {}).pt_job = job.id; job.created = true; }
                        }
                        persist();
                    }
                } else { nativeSaveFailures.delete(saveKey); if (job) { job.saveFailed = false; job.awaitingNativeSave = false; } }
            };
            const previous = nativeSaveChains.get(saveKey) || Promise.resolve();
            const request = previous.catch(() => {}).then(() => nativeFetch.call(host, input, init)).then(response => {
                note(response.ok ? null : new Error('聊天保存失败（HTTP ' + response.status + '）')); return response;
            }, error => { note(error); throw error; });
            nativeSaveChains.set(saveKey, request);
            return request.finally(() => { if (nativeSaveChains.get(saveKey) === request) nativeSaveChains.delete(saveKey); });
        }
        if (!disposed && typeof init?.body === 'string') {
            try {
                // 只有确实在换聊天时才提前隐藏；别的扩展读取聊天文件不应影响当前显示。
                const waiting = switching || Date.now() - navIntentAt < 5000 ? [...jobs.values()].filter(job => job.bgWritten && Number.isInteger(job.bgIndex)) : [];
                if (waiting.length && /\/api\/chats\/get$/.test(new URL(typeof input === 'string' ? input : input?.url || String(input), host.location.href).pathname)) {
                    const body = JSON.parse(init.body);
                    const job = waiting.find(item => item.avatar === body.avatar_url && item.chatId === String(body.file_name));
                    if (job) hidePending(job.bgIndex);
                }
            } catch { /* 只是为了提前隐藏原文，失败无妨 */ }
        }
        const arm = armed;
        if (arm && !disposed) {
            let match = false;
            try {
                const url = typeof input === 'string' ? input : input?.url || String(input);
                const method = String(init?.method || input?.method || 'GET').toUpperCase();
                match = Date.now() < arm.until && method === 'POST' && GEN_URL.test(new URL(url, host.location.href).pathname);
            } catch { /* 无法识别的请求原样放行 */ }
            if (match) { armed = null; return intercept(arm, input, init); }
        }
        return nativeFetch.apply(host, arguments);
    }
    let fetchHooked = true;
    try {
        host.fetch = parallelFetch;
        if (host.fetch !== parallelFetch) Object.defineProperty(host, 'fetch', { value: parallelFetch, configurable: true, writable: true });
    } catch (error) { fetchHooked = false; console.warn('[并行对话] 无法接管 fetch，后台生成不可用', error); }
    teardown.push(() => { if (host.fetch === parallelFetch) host.fetch = nativeFetch; });

    on(events.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun) { dryActiveUntil = Date.now() + 5000; return; }
        lastGenStart = Date.now();
        if (type === 'quiet') { quietPending++; return; }
        quietPending = 0;
        const info = current(), chat = ctx().chat, last = chat[chat.length - 1];
        gen = { type, info, replay: !!replayArm, cont: type === 'continue' && last ? { mes: String(last.mes ?? '') } : null,
            // 重新生成：酒馆只在页面里删掉旧回复、不存盘。记下它的特征，之后在文件里还能认出它。
            regenOld: type === 'regenerate' && last && !last.is_user ? { date: last.send_date ?? null, len: String(last.mes ?? '').length, head: String(last.mes ?? '').slice(0, 60) } : null };
        fgFinishedKey = null;
        building = info.key && TYPES.includes(type) ? { key: info.key, type, since: Date.now() } : null;
        log('gen:start', { type, s: sid(info.key) });
        // 很旧的宿主没有“提示词已就绪”事件：只能从生成开始就等下一条生成请求。
        if (!events.GENERATE_AFTER_DATA) armNext(90000);
        queueRender();
    });
    on(events.GENERATE_AFTER_DATA, (_data, dryRun) => {
        if (dryRun) { dryActiveUntil = 0; if (isOn()) scheduleReattach(50); return; }
        if (quietPending > 0) { quietPending--; return; }
        if (!gen) return;
        armNext(8000);
    });
    function armNext(ms) {
        if (!isOn()) return;
        if (!gen) return;
        if (replayArm && replayArm.job.key === gen.info.key) armed = { replay: replayArm.job, until: Date.now() + ms };
        else if (gen.info.key && TYPES.includes(gen.type)) armed = { gen, until: Date.now() + ms };
    }
    const generationOver = () => { later(() => { settle(); queueRender(); }, 150); };
    on(events.GENERATION_ENDED, () => {
        building = null; log('gen:ended'); generationOver();
        const finished = gen;
        if (!finished || finished.ended) return;
        finished.ended = true;
        later(() => {
            if (disposed || finished !== gen || finished.replay || Date.now() - lastStoppedAt < 1500 || isGenerating()) return;
            if (finished.info.key && finished.info.key === curKey) { fgFinishedKey = curKey; queueRender(); }
        }, 300);
    });
    on(events.GENERATION_STOPPED, () => { building = null; lastStoppedAt = Date.now(); fgFinishedKey = null; log('gen:stopped'); generationOver(); });
    on(events.CHAT_CHANGED, () => { chatSeenAt = Date.now(); fgFinishedKey = null; gen = null; armed = null; building = null; syncCurrent(); log('chat:changed', { s: sid(curKey) }); if (isOn()) restoreReading(curKey);
        const waiting = sessions.get(curKey)?.job;
        if (waiting?.bgWritten && Number.isInteger(waiting.bgIndex)) hidePending(waiting.bgIndex); else showPending();
        updateHandoff(); queueRender(); scheduleReattach(50); later(pumpBgWrites, 400);
    });
    // 酒馆对 APP_READY 的“晚到订阅者”会在 on() 里立刻同步回调；扩展加载得比酒馆就绪晚时，
    // 那一刻本函数后面的变量还没初始化，所以这里一律推迟到下一个任务再处理。
    on(events.APP_READY, () => later(() => { if (disposed) return; syncCurrent(); queueRender(); scheduleReattach(600); }, 0));

    // ----- 转入后台 / 切回 -----
    async function saveCurrentChat(key) {
        if (disposed || current().key !== key) throw new Error('聊天在保存前已改变');
        await ctx().saveChat();
        while (nativeSaveChains.has(key)) await nativeSaveChains.get(key);
        if (nativeSaveFailures.has(key)) throw nativeSaveFailures.get(key);
        if (current().key !== key) throw new Error('聊天在保存途中已改变');
        const job = sessions.get(key)?.job; if (job) { job.saveFailed = false; job.awaitingNativeSave = false; }
    }
    async function detach(job) {
        if (!job.attached || job.detaching) return false;
        job.detaching = true;
        const processor = nativeStream();
        let completed = false;
        log('detach:start', { s: sid(job.key), type: job.type, bytes: job.bytes });
        let ended = false;
        const onEnded = () => { ended = true; };
        emitter.on(events.GENERATION_ENDED, onEnded);
        try {
            ctx().stopGeneration();
            await waitFor(() => ended || (pressFlag() === false && !domGenerating()), 1200);
            if (disposed) return false;
            const idle = await waitFor(() => !isGenerating() && !isSwiping() && (!processor || nativeStream() !== processor) && nativeSaving?.() !== true, 8000);
            if (!idle) {
                log('detach:still-busy', genState());
                notify('酒馆还在处理这份回复，后台接收会继续；收尾完成后可再切换。');
                return false;
            }
            if (job.type === 'swipe') { await delay(150); await waitFor(() => !isSwiping(), 5000); }
            const c = ctx(), chat = c.chat, last = chat[chat.length - 1];
            if (current().key === job.key && last && !last.is_user) {
                let own = job.type === 'continue' || chat.length > job.baseLength;
                if (job.type === 'swipe' && Array.isArray(last.swipes) && last.swipes.length) {
                    // 首个字到达前中断时，酒馆把 swipe_id 留在尚不存在的那一格；存盘前先拨回。
                    if ((Number(last.swipe_id) || 0) >= last.swipes.length) { last.swipe_id = last.swipes.length - 1; last.mes = last.swipes[last.swipe_id]; }
                    own = job.swipeIndex >= 1 && last.swipes.length >= job.swipeIndex;
                }
                if (own) {
                    job.created = true;
                    (last.extra ||= {}).pt_job = job.id;
                    await saveCurrentChat(job.key);
                }
            }
            if (nativeSaveFailures.has(job.key)) throw nativeSaveFailures.get(job.key);
            completed = true;
            job.detachedAt = Date.now();
        } catch (error) {
            job.saveFailed = true;
            logError('detach-save', error); persist();
            notify('这份回复尚未保存，已保留后台数据。请恢复保存后再切换。');
            return false;
        } finally {
            emitter.removeListener ? emitter.removeListener(events.GENERATION_ENDED, onEnded) : emitter.off?.(events.GENERATION_ENDED, onEnded);
            // If native finalization timed out, retain ownership of this chat.
            // A later attempt must mark the partial reply before replaying it.
            job.pendingDetach = !completed;
            job.attached = !completed; job.detaching = false; job.front = null; job.onHead = null; job.onFail = null;
        }
        if (job.status !== 'running') { const session = sessions.get(job.key); if (session?.job === job) session.unread = true; persist(); }
        log('detach:done', { s: sid(job.key), created: job.created, status: job.status });
        queueRender();
        return true;
    }
    function scheduleReattach(ms) {
        cancelLater(reattachTimer);
        reattachTimer = later(() => void tryReattach(), ms);
    }
    function setEnabled(value) {
        value = value === true;
        if (value === isOn()) return true;
        if (value) {
            settings.parallelEnabled = true; save();
            log('parallel:on');
            restore(); syncCurrent();
            notify('已开启并行。发出消息后可以切到别的角色，回复会在后台继续。');
        } else {
            // 已经存进聊天文件的回复不算“没处理”：退出后打开那份聊天时仍会补做收尾。
            const pending = [...sessions.values()].filter(session => session.job && !session.job.bgWritten);
            if (pending.length || foregroundJob()) {
                panelOpen = true; pickerOpen = false; render();
                notify(`还有 ${pending.length || 1} 个会话的回复在生成或还没写回。请等它们完成并切回查看，或在面板里丢弃后再退出。`);
                return false;
            }
            if (drafts.size) { notify('其他会话还有未发送草稿，请先切回处理后再退出并行。'); return false; }
            settings.parallelEnabled = false; save();
            log('parallel:off');
            for (const job of [...jobs.values()]) if (job.bgWritten) jobs.delete(job.id);
            persist();
            sessions.clear(); drafts.clear(); readings.clear(); armed = null;
            notify('已退出并行，现在是普通聊天。');
        }
        host.dispatchEvent(new host.CustomEvent('pt-parallel-enabled', { detail: isOn() }));
        render();
        return true;
    }
    async function tryReattach() {
        if (disposed || reattachBusy || switching) return;
        const info = current();
        if (!info.key) return;
        const session = sessions.get(info.key), job = session?.job;
        if (!job) {
            // 任务已不存在（刷新、丢弃）：清掉旧标记即可，文本保持原样。
            const chat = ctx().chat, last = chat[chat.length - 1];
            if (last?.extra?.pt_job && !jobs.has(last.extra.pt_job)) delete last.extra.pt_job;
            const orphan = orphanIndex();
            if (orphan < 0) { showPending(); return; }
            if (!chat.length || isGenerating() || isSwiping() || nativeStream() || nativeSaving?.() === true || bgActive || doc.getElementById('curEditTextarea')?.offsetParent) { scheduleReattach(250); return; }
            reattachBusy = true; updateHandoff();
            try { await finalizeInPlace(null, null, orphan); }
            finally { reattachBusy = false; showPending(); updateHandoff(); render(); }
            return;
        }
        if (job.pendingDetach) {
            if (job.detaching || isGenerating() || isSwiping() || nativeStream() || nativeSaving?.() === true) { scheduleReattach(doc.hidden ? 800 : 150); return; }
            reattachBusy = true;
            try { if (!(await detach(job))) { scheduleReattach(800); return; } }
            finally { reattachBusy = false; }
            if (disposed || switching || current().key !== job.key || session.job !== job) return;
        }
        if (job.mismatch) return;
        if (job.attached || job.detaching || replayArm) return;
        // 聊天还在加载（消息数组暂时是空的）时先不判断，免得把“还没加载完”当成“聊天被改过”。
        if (!ctx().chat.length && job.baseLength > 0 && Date.now() - chatSeenAt < 15000) { scheduleReattach(300); return; }
        if (isGenerating() || isSwiping() || nativeStream() || nativeSaving?.() === true || Date.now() - sendIntentAt < 1500) { scheduleReattach(doc.hidden ? 800 : 150); return; }
        if (doc.getElementById('curEditTextarea')?.offsetParent) { scheduleReattach(1500); return; }
        // 后台写入还没落盘时先等它，再按“页面里实际加载到的版本”决定怎么收尾。
        if (bgActive) { scheduleReattach(120); return; }
        const written = markedIndex(job, 'pt_bg');
        if (written >= 0) {
            reattachBusy = true; updateHandoff();
            try { await finalizeInPlace(job, session, written); }
            finally { reattachBusy = false; showPending(); updateHandoff(); render(); }
            return;
        }
        if (job.bgWritten) {
            // 页面加载到的不是写入后的版本。本机还留着回复全文就按原来的方式写回；
            // 没留（记录是刷新后恢复的）说明回复早已进过聊天文件，这条记录没有可写的内容了。
            job.bgWritten = false; showPending();
            if (!job.bytes) { log('reattach:stale-record', { s: sid(job.key) }); drop(job); render(); return; }
        }
        // 聊天刚加载完酒馆会做一两次“试算提示词”，避开它正在进行的时刻。
        if (Date.now() < dryActiveUntil && !canFastWrite(job)) { scheduleReattach(250); return; }
        reattachBusy = true;
        try {
            const quick = canFastWrite(job);
            // 快速写回不发请求，不必等预设恢复；需要重放请求时才等，保证接口一致。
            if (!quick) { try { await profile?.activate?.(); } catch { /* 配置恢复失败不阻止写回 */ } }
            if (current().key !== job.key || isGenerating() || session.job !== job || job.attached) return;
            const c = ctx(), chat = c.chat, last = chat[chat.length - 1];
            const marked = !!last && !last.is_user && last.extra?.pt_job === job.id;
            let mode = null;
            if (job.type === 'swipe') {
                const index = job.swipeIndex;
                if (marked && index >= 1 && Array.isArray(last.swipes) && (last.swipes.length === index || last.swipes.length === index + 1)) {
                    // 去掉中断时留下的半截滑动，再让原生流程生成同一格。
                    last.swipes.length = index;
                    if (Array.isArray(last.swipe_info) && last.swipe_info.length > index) last.swipe_info.length = index;
                    last.swipe_id = index - 1; last.mes = last.swipes[index - 1];
                    delete last.extra.pt_job; mode = 'swipe';
                }
            } else if (job.type === 'continue') {
                if (marked && job.cont) {
                    last.mes = job.cont.mes;
                    if (Array.isArray(last.swipes) && last.swipes.length) last.swipes[Number(last.swipe_id) || 0] = job.cont.mes;
                    delete last.extra.pt_job; mode = 'continue';
                }
            } else if (marked && chat.length === job.baseLength + 1) {
                // 半截回复由这里直接删掉：酒馆“重新生成”自带的删除有渐隐动画，页面不渲染时
                // （切到后台、窗口被遮住）动画不走完，生成会一直卡在那一步。
                if (typeof c.deleteLastMessage === 'function') {
                    await c.deleteLastMessage();
                    if (disposed || current().key !== job.key || session.job !== job) return;
                    job.created = false;
                    const now = ctx().chat;
                    if (now.length === job.baseLength) mode = now[now.length - 1]?.is_user ? 'regenerate' : 'normal';
                } else mode = 'regenerate';
            } else if (!marked && chat.length === job.baseLength + 1 && isOldReply(job, last)) {
                // 文件里还是被重新生成的那条旧回复（切走时还没有新内容，酒馆也没存盘）。
                const failed = jobError(job);
                if (failed) {
                    log('reattach:regen-failed-keep-old', { s: sid(job.key) });
                    notify(`「${job.name}」的重新生成失败了（${failed}），原来的回复保留着。`);
                    drop(job); render(); return;
                }
                if (typeof c.deleteLastMessage === 'function') {
                    await c.deleteLastMessage();
                    if (disposed || current().key !== job.key || session.job !== job) return;
                    const now = ctx().chat;
                    if (now.length === job.baseLength) mode = now[now.length - 1]?.is_user ? 'regenerate' : 'normal';
                } else mode = 'regenerate';
            } else if (chat.length === job.baseLength && !last?.extra?.pt_job) mode = last?.is_user ? 'regenerate' : 'normal';
            log('reattach', { s: sid(job.key), type: job.type, mode, created: job.created, marked, len: chat.length, base: job.baseLength, status: job.status });
            if (!mode) {
                job.mismatch = true; session.unread = true;
                notify(`「${job.name}」的聊天内容已有变化，后台回复没有自动写入。可在并行面板里点“…”直接写入原消息、复制或丢弃。`);
                render(); return;
            }
            session.unread = false;
            if (quick && (mode === 'regenerate' || mode === 'normal') && await fastWrite(job)) { render(); return; }
            if (disposed || current().key !== job.key || session.job !== job || job.mismatch) return;
            const arm = replayArm = { job, draft: '', watch: null };
            const armedAt = Date.now();
            // 盯住这次原生生成：请求发出即成功；酒馆中途放弃或卡死则收拾现场，不让切换一直被挡住。
            arm.watch = host.setInterval(() => {
                if (replayArm !== arm || job.attached) { host.clearInterval(arm.watch); return; }
                const elapsed = Date.now() - armedAt, flag = pressFlag();
                const busy = flag === null ? domGenerating() : flag;
                if (elapsed < (flag === null ? 8000 : 1500) || (busy && elapsed < 45000)) return;
                host.clearInterval(arm.watch);
                replayFailed(job, session, busy ? 'hung' : 'bailed');
            }, 500);
            trigger(mode);
            queueRender();
        } finally { reattachBusy = false; }
    }
    // ===== 已收完的回复：直接走酒馆“收到回复”的原生流程，不重新组装提示词 =====
    function nativeClean(text, isContinue) {
        const clean = nativeCore?.cleanUpMessage;
        if (typeof clean !== 'function') return text;
        return clean.length >= 2 ? clean(text, false, isContinue, false)
            : clean({ getMessage: text, isImpersonate: false, isContinue, displayIncompleteSentences: false });
    }
    function nativeReasoning(text) {
        if (!text) return '';
        try { if (regexEngine?.getRegexedString) text = regexEngine.getRegexedString(text, regexEngine.regex_placement.REASONING); } catch { /* 正则不可用时保留原文 */ }
        return String(text).trim();
    }
    function canFastWrite(job) {
        return settings.fastWriteBack !== false && (job.type === 'normal' || job.type === 'regenerate')
            && job.status !== 'running' && !jobError(job)
            && typeof nativeCore?.saveReply === 'function' && typeof nativeCore?.cleanUpMessage === 'function';
    }
    async function fastWrite(job) {
        const got = parsed(job);
        if (!got.text && !got.reasoning) return false;
        const c = ctx(), before = c.chat.length;
        try {
            const clean = nativeClean(got.text, false), reasoning = nativeReasoning(got.reasoning);
            if (nativeCore.saveReply.length >= 2) await nativeCore.saveReply('normal', clean, false, '', [], reasoning);
            else await nativeCore.saveReply({ type: 'normal', getMessage: clean, reasoning });
            await saveCurrentChat(job.key);
            log('reattach:fast', { s: sid(job.key), len: ctx().chat.length });
            job.saveFailed = false; drop(job);
            // 原生流程在回复结束时会发出“生成结束”，依赖它的脚本（变量更新等）照常触发。
            try { await emitter.emit(events.GENERATION_ENDED, ctx().chat.length); } catch { /* 监听者自己的错误不影响写回 */ }
            return true;
        } catch (error) {
            logError('fast-write', error);
            // 没写进去就退回重放；写了一半则交给“直接写入/复制”处理。
            if (current().key === job.key && ctx().chat.length !== before) {
                const last = ctx().chat[ctx().chat.length - 1];
                if (last && !last.is_user) {
                    (last.extra ||= {}).pt_bg = job.id; last.extra.pt_bg_type = job.type;
                    job.created = true; job.saveFailed = true; job.finalizedMessage = last; job.finalizationKey = job.key;
                } else job.mismatch = true;
                const session = sessions.get(job.key); if (session) session.unread = true; persist(); render();
            }
            return false;
        }
    }

    // ===== 后台写入：回复收完（以及生成途中定时）直接存进那份没打开的聊天文件 =====
    const bgEnabled = () => isOn() && settings.backgroundWrite !== false && !bgBlocked;
    function bgEligible(job, final) {
        if (disposed || !bgEnabled() || !jobs.has(job.id) || job.bgSkip) return false;
        if (job.attached || job.detaching || job.pendingDetach || job.mismatch) return false;
        if (job.key === curKey || switching) return false;            // 打开着的聊天由酒馆自己写
        if (!job.head || job.failure || job.head.status >= 400 || (final && jobError(job))) return false;
        // 生成途中的进度保存默认关闭，需要在扩展设置里单独开启。
        return final ? job.status !== 'running' && !job.bgWritten : settings.backgroundProgress === true && job.status === 'running' && !job.bgNoProgress;
    }
    function chatFile(job, url, extra) {
        return withTimeout(nativeFetch.call(host, url, { method: 'POST', cache: 'no-cache', headers: ctx().getRequestHeaders(),
            body: JSON.stringify({ ch_name: job.name, file_name: job.chatId, avatar_url: job.avatar, ...extra }) }), 25000, '读写聊天文件');
    }
    // data = [文件头, ...消息]。只改属于这次回复的那一条；找不到位置就抛出 changed，不乱写。
    function applyToFile(job, data, final) {
        const changed = message => Object.assign(new Error(message), { changed: true });
        if (!data.length || typeof data[0] !== 'object' || data[0] === null) throw changed('聊天文件缺少文件头');
        const got = parsed(job), now = new Date().toISOString();
        let at = -1;
        for (let i = data.length - 1; i >= 1; i--) if (data[i]?.extra?.pt_job === job.id || data[i]?.extra?.pt_bg === job.id) { at = i; break; }
        let message;
        if (job.type === 'swipe') {
            message = data[at];
            if (!message || !Array.isArray(message.swipes) || !(job.swipeIndex >= 1) || message.swipes.length < job.swipeIndex) throw changed('找不到这次滑动的位置');
            message.swipes[job.swipeIndex] = got.text;
            message.swipe_id = job.swipeIndex; message.mes = got.text;
            if (Array.isArray(message.swipe_info)) message.swipe_info[job.swipeIndex] ||= { send_date: now, gen_started: new Date(job.startedAt || Date.now()).toISOString(), gen_finished: now, extra: {} };
        } else if (job.type === 'continue') {
            message = data[at];
            if (!message || !job.cont) throw changed('找不到要继续的那条消息');
            message.mes = job.cont.mes + got.text;
            if (Array.isArray(message.swipes) && message.swipes.length) message.swipes[Number(message.swipe_id) || 0] = message.mes;
        } else if (at >= 1) {
            message = data[at];
            message.mes = got.text;
            if (Array.isArray(message.swipes) && message.swipes.length) message.swipes[Number(message.swipe_id) || 0] = got.text;
        } else {
            // 切走时还没有任何输出，聊天里没有占位消息。
            // 重新生成的情况下文件末尾还是那条旧回复：用新回复顶替它，和酒馆原生的结果一致。
            if (data.length - 1 === job.baseLength + 1 && isOldReply(job, data[data.length - 1])) data.pop();
            // 其余情况只有消息数没变才在末尾新建。
            if (data.length - 1 !== job.baseLength) throw changed('聊天内容已变化');
            const started = new Date(job.startedAt || Date.now()).toISOString();
            message = { name: job.name, is_user: false, send_date: now, mes: got.text, title: '', gen_started: started, gen_finished: now,
                extra: { api: job.sig?.src || undefined, model: job.sig?.model || undefined }, swipe_id: 0, swipes: [got.text],
                swipe_info: [{ send_date: now, gen_started: started, gen_finished: now, extra: {} }] };
            data.push(message); at = data.length - 1;
        }
        if (message.is_user) throw changed('标记落在了用户消息上');
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        if (got.reasoning) { message.extra.reasoning = got.reasoning; message.extra.pt_bg_r = 1; }
        if (final) {
            delete message.extra.pt_job; message.extra.pt_bg = job.id; message.gen_finished = now;
            message.extra.pt_bg_type = job.type;
            if (job.type === 'swipe') message.extra.pt_bg_swipe = job.swipeIndex;
        } else message.extra.pt_job = job.id;
        return at - 1;
    }
    async function bgWrite(job, final) {
        if (!bgEligible(job, final)) return false;
        const got = parsed(job), length = got.text.length + got.reasoning.length;
        if (!length) { if (final) job.bgSkip = true; return false; }
        if (!final && length - (job.bgLength || 0) < 40) return false;
        bgActive++;
        try {
            const read = await chatFile(job, '/api/chats/get');
            if (!read.ok) throw Object.assign(new Error(`读取聊天失败（HTTP ${read.status}）`), { unsupported: [404, 405, 501].includes(read.status) });
            const raw = await read.text();
            let data;
            try { data = JSON.parse(raw); } catch { throw Object.assign(new Error('读取到的聊天不是有效数据'), { unsupported: true }); }
            if (!Array.isArray(data)) throw Object.assign(new Error('聊天文件不存在或为空'), { changed: true });
            if (raw.length > 6000000) job.bgNoProgress = true;      // 聊天很大时不做途中保存，只在收完时写一次
            const index = applyToFile(job, data, final);
            if (!bgEligible(job, final)) return false;             // 读取期间这份聊天被打开了，或任务状态变了
            const write = await chatFile(job, '/api/chats/save', { chat: data, force: false });
            if (!write.ok) {
                let reason = '';
                try { reason = (await write.json())?.error || ''; } catch { /* no body */ }
                if (reason === 'integrity') throw Object.assign(new Error('聊天文件在别处被改动'), { changed: true });
                throw Object.assign(new Error(`保存聊天失败（HTTP ${write.status}）`), { unsupported: [404, 405, 501].includes(write.status) });
            }
            job.bgLength = length; job.bgIndex = index; job.created = true; job.bgFails = 0; bgFailures = 0;
            if (final) { job.bgWritten = true; persist(); }
            log(final ? 'bg:written' : 'bg:progress', { s: sid(job.key), index, chars: length, type: job.type });
            queueRender();
            return true;
        } catch (error) {
            if (error.changed) { job.bgSkip = true; log('bg:skip', { s: sid(job.key), why: String(error.message).slice(0, 60) }); }
            else {
                logError('bg-write', error);
                job.bgFails = (job.bgFails || 0) + 1;
                if (job.bgFails >= 2) job.bgSkip = true;
                if (error.unsupported || ++bgFailures >= 3) { bgBlocked = String(error.message).slice(0, 120); log('bg:blocked', { why: bgBlocked }); }
            }
            return false;
        } finally { bgActive--; }
    }
    function pumpBgWrites() {
        if (disposed || !bgEnabled() || (doc.hidden && settings.backgroundProgress === true && ![...jobs.values()].some(job => job.status !== 'running'))) return;
        for (const job of jobs.values()) {
            const final = job.status !== 'running';
            if (job.bgQueued || !bgEligible(job, final)) continue;
            if (!final && Date.now() - (job.bgAt || job.detachedAt || Date.now()) < 20000) { job.bgAt ||= job.detachedAt || Date.now(); continue; }
            job.bgQueued = true; job.bgAt = Date.now();
            bgChain = bgChain.then(() => bgWrite(job, final)).catch(() => false).then(() => {
                job.bgQueued = false;
                if (!final && job.status !== 'running') later(pumpBgWrites, 30);   // 途中保存期间正好收完：马上补最终那次
            });
        }
    }
    const bgTimer = host.setInterval(pumpBgWrites, 5000);
    teardown.push(() => { host.clearInterval(bgTimer); cancelLater(hideTimer); hideStyle.remove(); });

    // 打开聊天时回复已经在里面了：用当前角色的规则做清理和正则，再补发原生事件，最后保存。
    function hidePending(index, ms = 2500) {
        hideStyle.textContent = `#chat .mes[mesid="${Number(index)}"] :is(.mes_text,.mes_reasoning_details){visibility:hidden!important}`;
        cancelLater(hideTimer); hideTimer = later(showPending, ms);
    }
    function showPending() { cancelLater(hideTimer); if (hideStyle.textContent) hideStyle.textContent = ''; }
    // job 可以为空：插件里的记录已经没有了（清过浏览器数据、超出本机存储、换了设备、已退出并行），
    // 这时只凭消息上的标记和消息里现有的文字完成收尾。
    async function finalizeInPlace(job, session, index) {
        const c = ctx(), message = c.chat[index], isLast = index === c.chat.length - 1, key = current().key;
        const meta = { ...(message?.extra || {}) };
        const type = job?.type || meta.pt_bg_type || 'normal';
        const swipeIndex = Number.isInteger(job?.swipeIndex) ? job.swipeIndex : Number(meta.pt_bg_swipe);
        const kind = type === 'swipe' ? 'swipe' : type === 'continue' ? 'continue' : 'normal';
        const who = job ? sid(job.key) : sid(key);
        const emit = async (name, ...args) => { if (!name) return; try { await emitter.emit(name, ...args); } catch (error) { logError('finalize:' + name, error); } };
        let touched = false;
        try {
            if (!message || message.is_user) throw new Error('找不到要收尾的消息');
            if ((job?.finalizedMessage === message && job.finalizationKey === key) || finalizedMessages.has(message)) {
                const retryMeta = { ...message.extra };
                for (const field of ['pt_bg', 'pt_job', 'pt_bg_type', 'pt_bg_swipe', 'pt_bg_r']) delete message.extra[field];
                try { await saveCurrentChat(key); }
                catch (error) { Object.assign(message.extra, retryMeta); throw error; }
                if (job) { job.saveFailed = false; if (session) session.unread = false; drop(job); } showPending();
                if (isLast) await emit(events.GENERATION_ENDED, ctx().chat.length);
                return;
            }
            hidePending(index, 10000);
            const got = job ? parsed(job) : { text: '', reasoning: '' };
            const inSwipe = kind === 'swipe' && Array.isArray(message.swipes) && Number.isInteger(swipeIndex) && message.swipes.length > swipeIndex;
            // 原文优先用插件里保存的那份；没有（记录已不在）就用聊天里这条消息现有的文字。
            const stored = String((inSwipe ? message.swipes[swipeIndex] : message.mes) ?? '');
            const raw = got.text ? (kind === 'continue' && job?.cont ? job.cont.mes + got.text : got.text) : stored;
            let text = nativeClean(raw, kind === 'continue');
            if (c.powerUserSettings?.trim_spaces !== false) text = String(text).trim();
            message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
            const wroteReasoning = !!message.extra.pt_bg_r;
            for (const field of ['pt_bg', 'pt_job', 'pt_bg_type', 'pt_bg_swipe', 'pt_bg_r']) delete message.extra[field];
            touched = true;
            if (inSwipe) { message.swipes[swipeIndex] = text; if (Number(message.swipe_id) === swipeIndex) message.mes = text; }
            else message.mes = text;
            if (got.reasoning) message.extra.reasoning = nativeReasoning(got.reasoning);
            else if (wroteReasoning && message.extra.reasoning) message.extra.reasoning = nativeReasoning(message.extra.reasoning);
            try { message.extra.api ||= nativeCore?.getGeneratingApi?.(); message.extra.model ||= nativeCore?.getGeneratingModel?.(message); } catch { /* optional */ }
            try {
                if (c.powerUserSettings?.message_token_count_enabled && typeof c.getTokenCountAsync === 'function') {
                    message.extra.token_count = await c.getTokenCountAsync((message.extra.reasoning || '') + message.mes, 0);
                }
            } catch { /* 计数失败不影响收尾 */ }
            // 顺序与酒馆收到一条回复时相同：先“收到消息”（脚本可在此改内容），再渲染，再“已渲染”。
            if (isLast) await emit(events.MESSAGE_RECEIVED, index, kind);
            if (disposed || current().key !== key || c.chat[index] !== message) throw new Error('聊天在处理途中被切换');
            try { c.updateMessageBlock?.(index, message); } catch (error) { logError('finalize:render', error); }
            await emit(isLast ? events.CHARACTER_MESSAGE_RENDERED : events.MESSAGE_UPDATED, ...(isLast ? [index, kind] : [index]));
            // 脚本可能在上面的事件里改了正文：把当前这一格滑动和它的附加信息同步成最终内容。
            if (Array.isArray(message.swipes) && message.swipes.length) {
                const at = Number(message.swipe_id) || 0;
                if (at < message.swipes.length) message.swipes[at] = message.mes;
                if (Array.isArray(message.swipe_info)) message.swipe_info[at] = { send_date: message.send_date, gen_started: message.gen_started, gen_finished: message.gen_finished, extra: structuredClone(message.extra) };
            }
            showPending();
            finalizedMessages.add(message);
            if (job) { job.finalizedMessage = message; job.finalizationKey = key; }
            await saveCurrentChat(key);
            log('bg:finalized', { s: who, index, last: isLast, type, orphan: !job });
            if (job) { if (session) session.unread = false; drop(job); }
            if (isLast) await emit(events.GENERATION_ENDED, ctx().chat.length);
        } catch (error) {
            logError('bg-finalize', error);
            showPending();
            // Keep the response until its final save is confirmed. Native saveChat
            // may resolve after swallowing a failed HTTP request.
            if (job && jobs.has(job.id)) {
                job.saveFailed = true; if (session) session.unread = true;
                if (touched && current().key === key && c.chat[index] === message) {
                    (message.extra ||= {}).pt_bg = job.id;
                    message.extra.pt_bg_type = type;
                    if (type === 'swipe') message.extra.pt_bg_swipe = swipeIndex;
                }
                persist();
            } else if (touched && current().key === key && c.chat[index] === message) {
                Object.assign(message.extra ||= {}, meta);
            }
            notify(`${job ? '「' + job.name + '」的' : '这条'}回复数据已保留，但收尾或保存尚未完成，可重试：${shortError(error)}`);
        }
    }
    function replayFailed(job, session, reason) {
        log('reattach:failed', { reason, s: sid(job.key), ...genState() });
        releaseReplay();
        if (reason === 'hung') unstick('replay-hung');
        try {
            // 重新生成可能已经把半截回复删掉了：按现在的聊天状态重新判断写回方式。
            if (current().key === job.key && job.type !== 'swipe' && job.type !== 'continue' && ctx().chat.length === job.baseLength) job.created = false;
        } catch { /* keep as is */ }
        job.retries = (job.retries || 0) + 1;
        if (job.retries >= 2 || job.type === 'swipe' || job.type === 'continue') {
            job.mismatch = true; session.unread = true;
            notify(`「${job.name}」的后台回复没能自动写入。可在并行面板里点“…”直接写入原消息、复制或丢弃。`);
        } else scheduleReattach(1500);
        render();
    }
    function trigger(mode) {
        const c = ctx();
        const click = id => { const node = doc.getElementById(id); if (node) { node.click(); return true; } return false; };
        const run = type => Promise.resolve().then(() => c.generate(type)).catch(error => console.warn('[并行对话] 回放失败', error));
        if (mode === 'regenerate') { if (!click('option_regenerate')) void run('regenerate'); }
        else if (mode === 'continue') { if (!click('option_continue')) void run('continue'); }
        else if (mode === 'swipe') {
            if (typeof c.swipe?.right === 'function') Promise.resolve().then(() => c.swipe.right()).catch(() => {});
            else doc.querySelector('#chat .last_mes .swipe_right')?.click();
        } else {
            // 末尾不是用户消息的普通生成：先收起输入框草稿，避免被当成新消息发出。
            const input = doc.getElementById('send_textarea');
            if (input?.value) { replayArm.draft = input.value; input.value = ''; }
            void run('normal');
        }
    }
    async function openSession(target) {
        if (disposed) return;
        if (switching) {
            // One native chat switch at a time, including slow save/replay.
            pendingSwitch = target; log('switch:queued'); return;
        }
        let originKey = null, draftNode = null, priorReadOnly = false;
        switching = true; switchingSince = Date.now(); updateHandoff();
        const known = target.chatId ? target.avatar + '\n' + target.chatId : [...sessions.keys()].find(key => key.startsWith(target.avatar + '\n'));
        log('switch:start', { to: known ? sid(known) : 'new', chat: !!target.chatId, ...genState() });
        try {
            recordReading();
            const now = current();
            if (now.avatar === target.avatar && (!target.chatId || now.chatId === target.chatId)) { log('switch:already-here'); panelOpen = false; pickerOpen = false; render(); scheduleReattach(50); return; }
            const character = ctx().characters.find(item => item?.avatar === target.avatar);
            const wantedChat = target.chatId || character?.chat;
            if (character && wantedChat && !sessions.has(target.avatar + '\n' + wantedChat) && sessions.size >= MAX_SESSIONS) {
                log('switch:refused-full');
                panelOpen = true; pickerOpen = false; render();
                notify(`已经有 ${MAX_SESSIONS} 个会话了。请先在面板里点会话右侧的“…”关闭一个，再打开新的。`);
                return;
            }
            if (bgActive) {
                log('switch:wait-bg');
                const ready = await waitFor(() => disposed || !bgActive, 26000);
                if (!ready) { notify('后台回复仍在保存，请稍后再切换。'); return; }
                if (disposed) return;
            }
            if (reattachBusy || replayArm) {
                // Keep this selection while the previous chat is preparing its
                // native replay. Once attached, detach that same live response
                // normally; never start a second request or change chat mid-save.
                log('switch:wait-replay');
                const ready = await waitFor(() => disposed || (!reattachBusy && !replayArm), 47000);
                if (disposed) return;
                if (!ready) { log('switch:replay-timeout'); notify('酒馆仍在接回后台回复，请稍后再切换。后台生成会继续。'); return; }
            }
            if (Date.now() - sendIntentAt < 1500 && !isGenerating()) {
                // 刚按下发送：等酒馆把这次生成立起来，否则消息会被发到切换后的聊天里。
                log('switch:wait-send');
                await waitFor(() => isGenerating(), 1500, 30);
            }
            if (isGenerating() && !foregroundJob() && building && building.key === curKey && sessions.has(curKey) && !sessions.get(curKey).job) {
                // 请求还没发出：等它发出再转入后台，而不是硬切（酒馆会拒绝）。
                log('switch:wait-request', genState());
                notify('这条消息的请求还没发出，发出后会自动转入后台并切换，请稍等…');
                await waitFor(() => !!foregroundJob() || !isGenerating() || !building, 30000, 100);
                log('switch:wait-over', genState());
            }
            if (isGenerating() || foregroundJob()?.pendingDetach) {
                const job = foregroundJob();
                if (!job) { log('switch:blocked-untracked', genState()); notify(sessions.get(curKey)?.job ? '这个对话还有一条没处理的后台回复（在面板里复制或丢弃它），所以这次新的生成不能转入后台。请等待完成或先停止。' : curKey && !sessions.has(curKey) ? `当前对话不在 ${MAX_SESSIONS} 个并行会话里，这次生成不能转入后台。请等待完成或先停止。` : '当前这次生成无法转入后台（群聊、扩展自己的请求或不支持的接口）。请等待完成或先停止。'); return; }
                if (!(await detach(job))) { log('switch:detach-refused'); return; }
            }
            if (nativeStream() || nativeSaving?.() === true) {
                log('switch:wait-save');
                const idle = await waitFor(() => !isGenerating() && !isSwiping() && !nativeStream() && nativeSaving?.() !== true, 8000);
                if (!idle) { notify('酒馆还在处理这份回复，请等收尾完成后再切换。后台生成会继续。'); return; }
            }
            if (disposed) return;
            if (profile?.blocked) {
                const ready = await waitFor(() => !profile?.blocked, 8000);
                if (disposed) return;
                if (!ready) { notify('角色配置正在恢复或尚未恢复，请先确认预设和代理后再切换。'); return; }
            }
            profile?.flush?.();
            const leavingKey = current().key;
            if (nativeSaveChains.has(leavingKey)) {
                try { while (nativeSaveChains.has(leavingKey)) await nativeSaveChains.get(leavingKey); }
                catch { notify('当前聊天保存失败，请恢复连接后再切换。'); return; }
                if (disposed) return;
            }
            if (nativeSaveFailures.has(current().key) || sessions.get(current().key)?.job?.awaitingNativeSave) {
                try { await saveCurrentChat(current().key); settle(); }
                catch { notify('当前聊天保存重试失败，回复已保留，请恢复连接后再切换。'); return; }
            }
            const c = ctx();
            const index = c.characters.findIndex(character => character?.avatar === target.avatar);
            if (index < 0) { log('switch:no-character'); notify('没有找到这个角色，请先刷新角色列表。'); return; }
            panelOpen = false; pickerOpen = false; render();
            originKey = current().key;
            draftNode = doc.getElementById('send_textarea');
            if (draftNode && originKey) {
                if (draftNode.value) drafts.set(originKey, String(draftNode.value)); else drafts.delete(originKey);
                priorReadOnly = draftNode.readOnly;
                // Avoid keystrokes landing in an intermediate native chat while loading.
                draftNode.readOnly = true;
            }
            const select = () => Promise.resolve(ctx().selectCharacterById(index, { switchMenu: false }));
            if (c.groupId || String(c.characterId) !== String(index)) {
                log('switch:select');
                await select();
                if (current().avatar !== target.avatar && !isGenerating()) {
                    // 酒馆正在保存聊天时会拒绝切换，稍等再试一次。
                    log('switch:retry', genState());
                    await delay(900);
                    await select();
                }
            }
            if (current().avatar !== target.avatar) { log('switch:not-switched', genState()); notify('酒馆没有完成切换（可能还在保存或生成），请稍后再试。'); return; }
            if (target.chatId && current().chatId !== target.chatId) {
                if (!(await chatExists(character, target.chatId))) {
                    log('switch:chat-missing');
                    notify('这份聊天记录已经不在该角色的历史里了（可能被改名或删除），没有打开，也没有新建。可在面板里关闭这个会话。');
                    return;
                }
                log('switch:open-chat');
                await c.openCharacterChat(target.chatId);
            }
            log('switch:done', { ms: Date.now() - switchingSince });
        } catch (error) {
            logError('switch', error);
            notify(`切换失败：${shortError(error)}`);
        } finally {
            if (draftNode) {
                const arrived = current().key;
                const input = doc.getElementById('send_textarea') || draftNode;
                if (arrived && originKey) {
                    const next = drafts.get(arrived) || '';
                    drafts.delete(arrived);
                    if (input.value !== next) { input.value = next; input.dispatchEvent(new host.Event('input', { bubbles: true })); }
                }
                draftNode.readOnly = priorReadOnly; input.readOnly = priorReadOnly;
            }
            switching = false;
            if (disposed) return;
            syncCurrent(); render();
            const next = pendingSwitch; pendingSwitch = null;
            if (next && !disposed) void openSession(next);
            else { scheduleReattach(50); later(pumpBgWrites, 400); }
        }
    }
    async function chatExists(character, chatId) {
        try {
            const response = await withTimeout(host.fetch('/api/characters/chats', {
                method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ avatar_url: character.avatar, ch_name: character.name }),
            }), 10000, '读取聊天列表');
            if (!response.ok) return false;
            const data = await response.json();
            if (!data || data.error) return false;
            return Object.values(data).some(item => item && typeof item.file_name === 'string' && item.file_name.replace(/\.jsonl$/i, '') === chatId);
        } catch (error) { logError('chat-list', error); return false; }
    }
    function closeSession(session) {
        if (session.job) {
            if (session.job.attached && isGenerating()) { notify('这个对话正在前台生成，请先停止或等待完成。'); return; }
            drop(session.job, { abort: true });
        }
        drafts.delete(session.key);
        if (session.key !== curKey) { sessions.delete(session.key); log('session:close', { s: sid(session.key) }); }
        // 腾出位置后，当前对话若还不是会话就补进来。
        syncCurrent();
        controlsKey = null; render();
    }
    // 自动写回做不了时的补救：把完整文本直接填进当初那条半截回复（不经过酒馆的生成流程）。
    // 这条消息是不是“正在被重新生成、但文件里还没删掉”的那条旧回复
    function isOldReply(job, message) {
        const old = job?.regenOld;
        if (!old || !message || message.is_user) return false;
        const text = String(message.mes ?? '');
        return (message.send_date ?? null) === old.date && text.length === old.len && text.startsWith(old.head);
    }
    // 带着“后台已写入、等待收尾”标记、但插件里已经没有对应记录的消息（只看最近几条）
    function orphanIndex() {
        try { const chat = ctx().chat; for (let i = chat.length - 1; i >= Math.max(0, chat.length - 5); i--) { const id = chat[i]?.extra?.pt_bg; if (id && !jobs.has(id)) return i; } } catch { /* not ready */ }
        return -1;
    }
    function markedIndex(job, field = 'pt_job') {
        try { const chat = ctx().chat; for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.extra?.[field] === job.id) return i; } catch { /* not ready */ }
        return -1;
    }
    async function writeDirect(job) {
        let writtenIndex = -1;
        try {
            if (current().key !== job.key) { notify('请先切到这份聊天再写入。'); return; }
            if (isGenerating() || nativeStream() || nativeSaving?.() === true || job.pendingDetach) { notify('酒馆正在生成或处理回复，请等它结束再写入。'); return; }
            const c = ctx(), index = markedIndex(job), got = parsed(job), text = String(got.text || '').trim();
            if (index < 0 || !text) { notify('没有找到可写入的位置或文本，可以改用“复制回复”。'); return; }
            writtenIndex = index;
            const message = c.chat[index];
            const full = job.type === 'continue' && job.cont ? job.cont.mes + got.text : text;
            if (job.type === 'swipe' && Array.isArray(message.swipes)) {
                const slot = message.swipes.length > job.swipeIndex ? job.swipeIndex : message.swipes.push(full) - 1;
                message.swipes[slot] = full;
                if (Number(message.swipe_id) === slot) message.mes = full;
            } else {
                message.mes = full;
                if (Array.isArray(message.swipes) && message.swipes.length) message.swipes[Number(message.swipe_id) || 0] = full;
            }
            message.extra ||= {};
            if (got.reasoning && !message.extra.reasoning) message.extra.reasoning = got.reasoning;
            delete message.extra.pt_job;
            try { c.updateMessageBlock?.(index, message); } catch (error) { logError('write-direct:render', error); }
            try { if (events.MESSAGE_UPDATED) await emitter.emit(events.MESSAGE_UPDATED, index); } catch (error) { logError('write-direct:event', error); }
            await saveCurrentChat(job.key);
            log('write-direct', { s: sid(job.key), index, type: job.type });
            drop(job);
            notify('已把完整回复写入原来那条消息。');
        } catch (error) {
            job.saveFailed = true;
            if (current().key === job.key) {
                const message = writtenIndex >= 0 ? ctx().chat[writtenIndex] : null;
                if (message && !message.is_user) (message.extra ||= {}).pt_job = job.id;
            }
            persist(); logError('write-direct', error); notify(`写入失败，回复已保留，可重试：${shortError(error)}`);
        }
    }
    function stopSession(session) {
        const job = session.job;
        if (session.key === current().key && (!job || (job.attached && !job.pendingDetach))) { try { ctx().stopGeneration(); } catch (error) { notify(`停止失败：${shortError(error)}`); } return; }
        if (job?.status === 'running') {
            if (!job.head) { drop(job, { abort: true }); notify('已停止，这次回复还没有收到内容。'); return; }
            // 保留已收到的部分，切回后照常写入。
            job.keepPartial = true; job.status = 'done';
            try { job.ac.abort(); } catch { /* ignore */ }
        }
        queueRender();
    }
    async function copyText(value, done) {
        try { await host.navigator.clipboard.writeText(value); notify(done); }
        catch {
            const area = element('textarea'); area.id = 'pt-diagnostic-text'; area.value = value; area.readOnly = true; area.style.cssText = 'width:calc(100% - 40px);height:180px';
            picker.replaceChildren(element('p', 'pt-muted', '浏览器不允许自动复制，请长按下面的文字全选后复制。'), area, button('返回', () => { pickerOpen = false; render(); }));
            pickerOpen = true; panelOpen = true; render(); area.focus(); area.select();
        }
    }
    function copyJob(job) {
        const { text, reasoning } = parsed(job);
        return copyText(text || reasoning || bodyText(job), '已复制回复文本。');
    }
    function diagnosticReport() {
        let appVersion = null;
        try { appVersion = doc.querySelector('#version_display, #version_display_welcome')?.textContent?.trim().slice(0, 80) || null; } catch { /* optional */ }
        return {
            plugin: VERSION, time: new Date().toISOString(), uptimeMs: Date.now() - startedAt,
            userAgent: host.navigator.userAgent, tauri: !!(host.__TAURI__ || host.__TAURI_INTERNALS__), app: appVersion,
            viewport: [host.innerWidth, host.innerHeight], visible: doc.visibilityState,
            mainApi: (() => { try { return ctx().mainApi; } catch { return null; } })(),
            group: !!current().group, current: sid(curKey),
            state: { ...genState(), switching, switchingForMs: switching ? Date.now() - switchingSince : 0, reattachBusy, replayArmed: !!replayArm, fetchArmed: !!armed, parallelOn: isOn(), fetchHooked: host.fetch === parallelFetch, hasPromptEvent: !!events.GENERATE_AFTER_DATA, launcherSide, panelOpen, drafts: drafts.size },
            replyStorage: { ...storageStatus },
            backgroundWrite: { enabled: settings.backgroundWrite !== false, progress: settings.backgroundProgress === true, blocked: bgBlocked, active: bgActive, fast: canFastWrite({ type: 'normal', status: 'done' }) },
            sessions: [...sessions.values()].map(s => ({ s: sid(s.key), here: s.key === curKey, unread: s.unread,
                job: s.job ? { type: s.job.type, status: s.job.status, attached: s.job.attached, detaching: s.job.detaching, http: s.job.head?.status ?? null, bytes: s.job.bytes, created: s.job.created, mismatch: !!s.job.mismatch } : null })),
            errors, log: logs.map(entry => entry.length > 2 ? `${entry[0]} ${entry[1]} ${JSON.stringify(entry[2])}` : `${entry[0]} ${entry[1]}`),
        };
    }
    const exportDiagnostics = () => copyText(JSON.stringify(diagnosticReport(), null, 1), '诊断记录已复制，可以直接粘贴发送。');

    // ----- 提示音 -----
    const soundKey = 'parallel-tavern.completion-sound';
    let nightMode = false, soundEnabled = true, audioContext = null;
    try { nightMode = host.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch { /* default */ }
    try { soundEnabled = host.localStorage.getItem(soundKey) !== 'off'; } catch { /* default */ }
    function unlockSound() {
        if (!soundEnabled || disposed) return;
        try {
            const Audio = host.AudioContext || host.webkitAudioContext;
            if (!Audio) return;
            audioContext ||= new Audio();
            if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
        } catch { /* 音频限制不能影响聊天 */ }
    }
    function completionSound() {
        if (!soundEnabled || disposed || audioContext?.state !== 'running') return;
        try {
            const at = audioContext.currentTime;
            const gain = audioContext.createGain(); gain.connect(audioContext.destination);
            gain.gain.setValueAtTime(0, at);
            gain.gain.linearRampToValueAtTime(0.10, at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, at + 0.6);
            const tone = audioContext.createOscillator(); tone.type = 'sine';
            tone.frequency.setValueAtTime(660, at); tone.frequency.setValueAtTime(880, at + 0.16);
            tone.connect(gain);
            tone.onended = () => { tone.disconnect(); gain.disconnect(); };
            tone.start(at); tone.stop(at + 0.65);
        } catch { /* 没有输出设备 */ }
    }
    host.addEventListener('pointerdown', unlockSound, true);
    host.addEventListener('keydown', unlockSound, true);
    teardown.push(() => {
        host.removeEventListener('pointerdown', unlockSound, true); host.removeEventListener('keydown', unlockSound, true);
        if (audioContext) void audioContext.close().catch(() => {});
    });

    // ----- 界面 -----
    let launcherVisible = settings.showLauncher !== false;
    let panelOpen = false, pickerOpen = false, menuOpen = false, controlsKey = null;
    let launcherSide = null, launcherSignature = '', badgeSignature = '';
    let launcherRatio = 0.5;
    try {
        const dock = JSON.parse(host.localStorage.getItem('parallel-tavern.launcher-dock') || 'null');
        if (['left', 'right'].includes(dock?.side)) launcherSide = dock.side;
        if (Number.isFinite(dock?.ratio)) launcherRatio = Math.max(0, Math.min(1, dock.ratio));
    } catch { /* default position */ }
    let renderPending = false, pointerActive = false, toastTimer;
    const element = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (text, fn, label = text) => {
        const node = element('button', 'pt-button', text);
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        node.addEventListener('click', fn);
        return node;
    };
    const shortError = error => String(error?.message || error || '未知错误').slice(0, 240);
    function iconButton(label, name, action) {
        const node = button('', action, label); node.classList.add('pt-icon-button');
        const paths = { minus: 'M5 12h14', more: 'M5 12h.01M12 12h.01M19 12h.01' };
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'pt-icon'); svg.setAttribute('aria-hidden', 'true');
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.more);
        svg.append(path); node.append(svg); return node;
    }
    const portraitCache = new Map();
    function stablePortrait(slot, item) {
        const id = slot + '|' + item.avatar + '|' + item.name;
        let face = portraitCache.get(id);
        if (!face) {
            face = portrait(item, false);
            portraitCache.set(id, face);
            if (portraitCache.size > 60) portraitCache.delete(portraitCache.keys().next().value);
        }
        return face;
    }
    function portrait(item, lazy = true) {
        const face = element('span', 'pt-portrait', [...(item.name || '聊')][0]);
        face.setAttribute('aria-hidden', 'true');
        try {
            const url = item.avatar && ctx().getThumbnailUrl?.('avatar', item.avatar);
            if (url) {
                const img = doc.createElement('img'); img.alt = ''; if (lazy) { img.loading = 'lazy'; img.decoding = 'async'; } img.src = url;
                img.addEventListener('error', () => img.remove(), { once: true }); face.append(img);
            }
        } catch { /* 缩略图不可用时保留首字 */ }
        return face;
    }
    const launcher = button('并行', event => {
        if (launcherSide) { expandLauncher(); panelOpen = true; pickerOpen = false; render(); return; }
        if (settings.avatarQuickSwitch === true && event.detail > 0) {
            const face = [...launcher.querySelectorAll('[data-pt-session]')].reverse().find(node => {
                const r = node.getBoundingClientRect();
                return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
            });
            const session = face && sessions.get(face.dataset.ptSession);
            if (session) { log('face:tap', { s: sid(session.key), index: [...sessions.keys()].indexOf(session.key) }); void openSession(session); return; }
        }
        panelOpen = !panelOpen; pickerOpen = false; render();
    });
    launcher.id = 'pt-launcher'; launcher.dataset.ttMobileSurface = 'free-window';
    if (launcherSide) { launcher.dataset.side = launcherSide; launcher.dataset.ptDragged = 'true'; }
    const completionBadge = element('span'); completionBadge.id = 'pt-completion-badge'; completionBadge.hidden = true; completionBadge.setAttribute('aria-hidden', 'true');
    const panel = element('section'); panel.id = 'pt-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', '并行角色会话'); panel.dataset.ttMobileSurface = 'free-window';
    const picker = element('section'); picker.id = 'pt-picker'; picker.hidden = true;
    const toast = element('div'); toast.id = 'pt-toast'; toast.hidden = true; toast.setAttribute('role', 'status');
    const handoffIndicator = element('div'); handoffIndicator.id = 'pt-handoff'; handoffIndicator.hidden = true;
    handoffIndicator.setAttribute('role', 'status'); handoffIndicator.setAttribute('aria-live', 'polite');
    const handoffLabel = element('span'); handoffIndicator.append(handoffLabel);
    const safeArea = element('div');
    safeArea.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    doc.body.append(launcher, panel, toast, completionBadge, safeArea, handoffIndicator);
    teardown.push(() => { doc.body.removeAttribute('data-pt-handoff'); for (const node of [launcher, panel, toast, completionBadge, safeArea, handoffIndicator]) node.remove(); });

    // Native stop/send controls describe the one foreground consumer, not the
    // retained network requests. Show an explicit handoff state over that spot
    // while it is released/reconnected; keep all native flags/events intact.
    function updateHandoff() {
        const job = sessions.get(current().key)?.job;
        const pending = job && !job.mismatch && (!job.attached || job.pendingDetach);
        const visible = !disposed && isOn() && !!((switching && jobs.size) || reattachBusy || replayArm || pending);
        handoffIndicator.hidden = !visible;
        if (!visible) { doc.body.removeAttribute('data-pt-handoff'); return; }
        const running = [...jobs.values()].some(item => item.status === 'running');
        const label = switching ? (running ? '切换中 · 后台继续生成' : '正在切换对话') : (running ? '接回中 · 后台继续生成' : '正在接回回复');
        if (handoffLabel.textContent !== label) handoffLabel.textContent = label;
        let rect;
        for (const id of ['rightSendForm', 'mes_stop', 'send_but', 'send_textarea']) {
            const candidate = doc.getElementById(id)?.getBoundingClientRect();
            if (candidate?.width && candidate.height) { rect = candidate; break; }
        }
        if (!rect) { handoffIndicator.hidden = true; doc.body.removeAttribute('data-pt-handoff'); return; }
        const size = 26, viewport = host.visualViewport;
        const leftBound = viewport?.offsetLeft || 0, topBound = viewport?.offsetTop || 0;
        const width = viewport?.width || host.innerWidth, height = viewport?.height || host.innerHeight;
        handoffIndicator.style.left = `${Math.max(leftBound + 8, Math.min(leftBound + width - size - 8, rect.right - size))}px`;
        handoffIndicator.style.top = `${Math.max(topBound + 8, Math.min(topBound + height - size - 8, rect.top + (rect.height - size) / 2))}px`;
        handoffIndicator.dataset.night = String(nightMode);
        doc.body.setAttribute('data-pt-handoff', 'true');
    }
    let handoffTimer = null;
    const scheduleHandoff = () => { if (handoffTimer === null && !disposed) handoffTimer = later(() => { handoffTimer = null; updateHandoff(); }, 60); };
    const handoffObserver = typeof host.MutationObserver === 'function' ? new host.MutationObserver(scheduleHandoff) : null;
    for (const id of ['send_but', 'mes_stop']) {
        const node = doc.getElementById(id); if (node) handoffObserver?.observe(node, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    teardown.push(() => handoffObserver?.disconnect());

    function floatingBounds() {
        const v = host.visualViewport, css = host.getComputedStyle(safeArea), root = host.getComputedStyle(doc.documentElement);
        const usable = n => Number.isFinite(n) && n >= 80;
        const vw = usable(v?.width) ? v.width : (host.innerWidth || doc.documentElement.clientWidth || 360);
        const vh = usable(v?.height) ? v.height : (host.innerHeight || doc.documentElement.clientHeight || 640);
        const x = usable(v?.width) && Number.isFinite(v.offsetLeft) ? v.offsetLeft : 0;
        const y = usable(v?.height) && Number.isFinite(v.offsetTop) ? v.offsetTop : 0;
        const inset = (side, padding, limit) => Math.min(limit / 4, Math.max(0, parseFloat(root.getPropertyValue(`--tt-inset-${side}`)) || parseFloat(padding) || 0));
        return { left: x + inset('left', css.paddingLeft, vw) + 12, top: y + inset('top', css.paddingTop, vh) + 12,
            right: x + vw - inset('right', css.paddingRight, vw) - 12, bottom: y + vh - inset('bottom', css.paddingBottom, vh) - 12 };
    }
    function positionCompletionBadge() {
        if (completionBadge.hidden || launcherSide) return;
        const faces = [...launcher.querySelectorAll('[data-pt-session]')];
        for (const badge of completionBadge.children) {
            const face = faces.find(node => node.dataset.ptSession === badge.dataset.ptSession);
            badge.hidden = !face;
            if (!face) continue;
            const r = face.getBoundingClientRect();
            badge.style.setProperty('left', `${Math.max(2, r.right - 8)}px`, 'important');
            badge.style.setProperty('top', `${Math.max(2, r.top - 5)}px`, 'important');
        }
    }
    function show(node, visible) {
        if ((node === launcher || node === completionBadge) && !launcherVisible) visible = false;
        node.hidden = !visible;
        if (visible) {
            node.style.setProperty('visibility', 'visible', 'important');
            node.style.setProperty('opacity', '1', 'important');
            node.style.setProperty('position', 'fixed', 'important');
            if (node !== toast) node.style.setProperty('transform', 'none', 'important');
        }
    }
    function saveLauncherDock() {
        try { host.localStorage.setItem('parallel-tavern.launcher-dock', JSON.stringify({ side: launcherSide, ratio: launcherRatio })); } catch { /* optional */ }
    }
    function dockLauncher(side) {
        const b = floatingBounds(), r = launcher.getBoundingClientRect();
        launcherRatio = Math.max(0, Math.min(1, (r.top + r.height / 2 - b.top) / Math.max(1, b.bottom - b.top)));
        launcherSide = side; launcher.dataset.side = side; launcher.dataset.ptDragged = 'true';
        saveLauncherDock(); panelOpen = false; pickerOpen = false; render();
    }
    function expandLauncher() {
        const side = launcherSide;
        launcherSide = null; delete launcher.dataset.side;
        saveLauncherDock();
        const b = floatingBounds();
        launcher.style.setProperty('left', `${side === 'left' ? b.left : b.right - launcher.offsetWidth}px`, 'important');
        launcher.style.setProperty('top', `${Math.max(b.top, Math.min(b.bottom - launcher.offsetHeight, b.top + launcherRatio * (b.bottom - b.top) - launcher.offsetHeight / 2))}px`, 'important');
        launcherSignature = ''; render();
    }
    function draggable(node, handle) {
        let drag = null, suppressClick = false;
        node.addEventListener('pointerdown', e => {
            if (e.button !== 0 || drag || !handle(e.target)) return;
            suppressClick = false;
            const rect = node.getBoundingClientRect(), b = floatingBounds();
            const edge = rect.left <= b.left + 24 ? 'left' : rect.right >= b.right - 24 ? 'right' : null;
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false, edge, side: launcherSide };
            if (node === launcher) pointerActive = true;
            try { node.setPointerCapture?.(e.pointerId); } catch { /* WebView 可能已释放指针 */ }
        });
        node.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            // 手指点按常带十来像素的抖动，阈值太小会把点按当成拖动而吞掉点击。
            if (Math.abs(dx) + Math.abs(dy) < (e.pointerType === 'mouse' ? 5 : 14) && !drag.moved) return;
            drag.moved = true; e.preventDefault();
            node.dataset.ptDragged = 'true';
            const bounds = floatingBounds();
            if (node === launcher && launcherSide) {
                launcherRatio = Math.max(0, Math.min(1, (drag.top + node.offsetHeight / 2 + dy - bounds.top) / Math.max(1, bounds.bottom - bounds.top)));
                keepFloatingVisible(); return;
            }
            const left = node === launcher && launcherSide ? (launcherSide === 'left' ? bounds.left : bounds.right - node.offsetWidth)
                : Math.max(bounds.left, Math.min(bounds.right - node.offsetWidth, drag.left + dx));
            const top = Math.max(bounds.top, Math.min(bounds.bottom - node.offsetHeight, drag.top + dy));
            for (const [k, v] of [['left', left + 'px'], ['top', top + 'px'], ['right', 'auto'], ['bottom', 'auto'], ['margin', '0']]) node.style.setProperty(k, v, 'important');
            if (node === launcher) positionCompletionBadge();
        });
        node.addEventListener('pointerup', e => {
            if (!drag || e.pointerId !== drag.id) return;
            const finished = drag; drag = null;
            suppressClick = finished.moved;
            if (node !== launcher) return;
            pointerActive = false;
            const dx = e.clientX - finished.x, dy = e.clientY - finished.y;
            if (Math.abs(dx) >= 32 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                if (finished.side && (finished.side === 'left' ? dx > 0 : dx < 0)) expandLauncher();
                else if (!finished.side && finished.edge && (finished.edge === 'left' ? dx < 0 : dx > 0)) dockLauncher(finished.edge);
            }
            if (finished.side) saveLauncherDock();
            keepFloatingVisible();
        });
        const cancelDrag = e => {
            if (!drag || e.pointerId !== drag.id) return;
            suppressClick = drag.moved; drag = null;
            if (node === launcher) { pointerActive = false; keepFloatingVisible(); }
        };
        node.addEventListener('pointercancel', cancelDrag);
        node.addEventListener('lostpointercapture', cancelDrag);
        node.addEventListener('click', e => { if (suppressClick && e.detail > 0) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
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
            if (node === panel) { set(node, 'width', `${Math.min(364, width)}px`); set(node, 'max-height', `${Math.max(1, height - panelReserve)}px`); }
            if (node.hidden || !node.offsetHeight) continue;
            const rect = node.getBoundingClientRect();
            if (node === launcher && launcherSide) {
                set(node, 'top', `${Math.max(b.top, Math.min(b.bottom - rect.height, b.top + launcherRatio * height - rect.height / 2))}px`);
                set(node, 'left', `${launcherSide === 'left' ? b.left - 12 : b.right + 12 - rect.width}px`);
                set(node, 'right', 'auto'); set(node, 'bottom', 'auto'); set(node, 'margin', '0px');
                continue;
            }
            const preferredTop = node.dataset.ptDragged ? rect.top : b.bottom - rect.height - (node === panel ? panelReserve : compact ? 0 : 76);
            const top = Math.max(b.top, Math.min(b.bottom - rect.height, preferredTop));
            const left = node === launcher && launcherSide ? (launcherSide === 'left' ? b.left : b.right - rect.width)
                : Math.max(b.left, Math.min(b.right - rect.width, node.dataset.ptDragged ? rect.left : b.right - rect.width));
            set(node, 'top', `${top}px`); set(node, 'left', `${left}px`);
            set(node, 'right', 'auto'); set(node, 'bottom', 'auto'); set(node, 'margin', '0px');
        }
        if (!toast.hidden) {
            set(toast, 'max-width', `${width}px`);
            set(toast, 'left', `${(b.left + b.right) / 2}px`);
            set(toast, 'top', `${Math.max(b.top, b.bottom - toast.offsetHeight)}px`); set(toast, 'bottom', 'auto');
        }
        positionCompletionBadge();
        updateHandoff();
    }
    // 面板、悬浮入口、提示条的尺寸一变（列表加载完、搜索筛选、头像载入、展开设置…）就重新摆放。
    let floatingFrame = null;
    const scheduleFloatingLayout = () => {
        if (disposed || floatingFrame !== null) return;
        floatingFrame = host.requestAnimationFrame(() => { floatingFrame = null; if (!disposed) keepFloatingVisible(); });
    };
    const floatObserver = typeof host.ResizeObserver === 'function' ? new host.ResizeObserver(scheduleFloatingLayout) : null;
    for (const node of [panel, launcher, toast]) floatObserver?.observe(node);
    host.addEventListener('resize', scheduleFloatingLayout);
    host.visualViewport?.addEventListener('resize', scheduleFloatingLayout);
    host.visualViewport?.addEventListener('scroll', scheduleFloatingLayout);
    teardown.push(() => {
        floatObserver?.disconnect(); if (floatingFrame !== null) host.cancelAnimationFrame(floatingFrame);
        host.removeEventListener('resize', scheduleFloatingLayout);
        host.visualViewport?.removeEventListener('resize', scheduleFloatingLayout); host.visualViewport?.removeEventListener('scroll', scheduleFloatingLayout);
    });
    function notify(message) {
        toast.textContent = message; show(toast, true); keepFloatingVisible();
        cancelLater(toastTimer); toastTimer = later(() => show(toast, false), 6500);
    }

    panel.addEventListener('pointerdown', () => { pointerActive = true; }, true);
    const releasePointer = () => { pointerActive = false; };
    host.addEventListener('pointerup', releasePointer, true);
    host.addEventListener('pointercancel', releasePointer, true);
    teardown.push(() => { host.removeEventListener('pointerup', releasePointer, true); host.removeEventListener('pointercancel', releasePointer, true); });
    function queueRender() {
        if (renderPending || disposed) return;
        renderPending = true;
        later(() => { renderPending = false; if (!disposed) { if (pointerActive) queueRender(); else render(); } }, 160);
    }

    // 两步确认：第一次点击变成确认文字，4 秒内再点才执行。不依赖 window.confirm。
    let confirmId = null, confirmTimer = null;
    function confirmButton(label, sureLabel, id, action) {
        const sure = confirmId === id;
        const node = button(sure ? sureLabel : label, () => {
            cancelLater(confirmTimer);
            if (confirmId === id) { confirmId = null; action(); render(); return; }
            confirmId = id; confirmTimer = later(() => { confirmId = null; queueRender(); }, 4000);
            render();
        }, label);
        if (sure) node.classList.add('pt-danger');
        return node;
    }
    function stateOf(session, detail = true) {
        const job = session.job, here = session.key === curKey;
        if (job?.status === 'running') {
            if (!detail) return { state: 'busy', busy: true, label: '' };
            if (here && job.attached && !job.detaching && !job.pendingDetach) return { state: 'busy', busy: true, label: '正在回复…' };
            const got = parsed(job);
            return { state: 'busy', busy: true, label: got.text ? `后台生成中 · 已收到 ${got.text.length} 字` : got.reasoning ? `后台生成中 · 正在思考（${got.reasoning.length} 字）` : '后台生成中 · 等待首个字' };
        }
        if (job && (!job.attached || job.detaching || job.pendingDetach)) {
            if (job.mismatch) return { state: 'error', label: '未自动写入 · 点右侧“…”处理' };
            if (jobError(job)) return { state: 'error', label: '生成失败 · 切回查看原因' };
            if (job.bgWritten) return { state: 'done', label: here ? '正在收尾…' : job.truncated ? '已中断 · 已收到的部分已存入聊天' : '已完成 · 已存入聊天，切回即可看' };
            return { state: 'done', label: here ? '正在写回…' : job.truncated ? '已中断 · 切回写入已收到的部分' : '已完成 · 点击切回查看' };
        }
        if (here && isGenerating()) return { state: 'busy', busy: true, label: '正在回复…' };
        return { state: 'idle', label: here ? '当前对话' : '待命' };
    }
    function preview(session) {
        try {
            if (session.job && (!session.job.attached || session.job.pendingDetach)) {
                const { text, reasoning } = parsed(session.job);
                if (text || reasoning) return (text || reasoning).slice(-200);
            }
            if (session.key === curKey) {
                const chat = ctx().chat;
                for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) return String(chat[i].mes || '').slice(-200);
            }
        } catch { /* 尚未就绪 */ }
        return '';
    }
    function updateLauncher() {
        const all = [...sessions.values()];
        const states = all.map(session => stateOf(session, false));
        const running = states.filter(s => s.busy).length;
        const completed = all.filter(s => s.unread);
        const finished = completed.length > 0 || (!!fgFinishedKey && fgFinishedKey === curKey);
        launcher.dataset.state = running ? 'generating' : finished ? 'completed' : 'idle';
        const sig = JSON.stringify([isOn(), running, completed.length, all.map(s => [s.key, s.name])]);
        if (sig !== launcherSignature) {
            launcherSignature = sig;
            const dock = element('span', 'pt-dock'), faces = element('span', 'pt-dock-faces');
            for (const s of all) { const face = stablePortrait('dock:' + s.key, s); face.dataset.ptSession = s.key; faces.append(face); }
            if (!all.length) faces.append(portrait({ name: '并' }));
            const label = element('span', 'pt-dock-label', completed.length ? `${completed.length} 个已完成` : '并行会话');
            label.append(element('span', 'pt-dock-note', !isOn() ? '点击开启' : running ? `${running} 个正在回复` : '点开查看会话'));
            dock.append(faces, label);
            launcher.replaceChildren(dock);
        }
        const nextBadge = JSON.stringify(completed.map(s => s.key));
        if (nextBadge !== badgeSignature) {
            badgeSignature = nextBadge;
            completionBadge.replaceChildren(...completed.map(s => { const badge = element('span', 'pt-avatar-badge', '1'); badge.dataset.ptSession = s.key; return badge; }));
        }
        show(completionBadge, completed.length > 0 && !launcherSide); positionCompletionBadge();
        const label = launcherSide ? `并行对话：${running ? `${running} 个会话正在生成` : finished ? '生成已完成' : '暂无生成'}；点击或向内滑动展开`
            : completed.length ? `并行对话：${completed.map(s => s.name).join('、')} 已生成完成，待查看` : '并行对话；拖到边缘后向外滑动可收起';
        launcher.title = label; launcher.setAttribute('aria-label', label);
    }
    function applyTheme() { for (const node of [panel, launcher, toast, completionBadge]) node.dataset.night = String(nightMode); }
    function setNightMode(value) {
        nightMode = !!value;
        try { host.localStorage.setItem('parallel-tavern.night-mode', nightMode ? 'on' : 'off'); } catch { /* ignore */ }
        applyTheme(); render();
        host.dispatchEvent(new host.CustomEvent('pt-night-mode', { detail: nightMode }));
    }
    function render() {
        if (disposed) return;
        applyTheme(); updateLauncher();
        launcher.setAttribute('aria-expanded', String(!launcherSide && panelOpen));
        show(panel, panelOpen); picker.hidden = !pickerOpen; show(launcher, true);
        // 先填内容再定位：面板高度随内容变化，按旧高度定位会把下半截推到屏幕外。
        if (panelOpen) buildPanel();
        keepFloatingVisible();
    }
    function buildPanel() {
        if (pickerOpen) { if (picker.parentNode !== panel) panel.replaceChildren(picker); return; }
        panel.replaceChildren();
        const row = element('div', 'pt-row');
        const heading = element('span', 'pt-heading', 'Parallel');
        heading.append(element('span', 'pt-subheading', '并 行 会 话'));
        const add = button('＋ 打开对话', showPicker, '打开对话'); add.classList.add('pt-add');
        row.append(heading, ...(isOn() ? [add] : []), iconButton('收起', 'minus', () => { panelOpen = false; render(); }));
        panel.append(row);
        if (!isOn()) {
            const welcome = element('div', 'pt-welcome');
            welcome.append(element('p', 'pt-muted', '一个角色在回复，也能切去和另一个角色聊天。最多同时保留 3 个会话。不开启时就是普通聊天，本扩展不做任何处理。'));
            welcome.append(button('开启角色并行', () => {
                if (current().group) { notify('群聊暂不支持并行，请先打开一个单角色聊天。'); return; }
                setEnabled(true);
            }));
            panel.append(welcome);
            return;
        }
        const all = [...sessions.values()];
        const overview = element('div', 'pt-overview');
        if (storageStatus.state === 'failed' || storageStatus.state === 'limited') {
            panel.append(element('p', 'pt-error pt-storage-warning', storageStatus.state === 'failed'
                ? '后台回复未能保存到本设备，刷新后可能丢失。请先切回写入或复制回复。'
                : `有 ${storageStatus.omitted} 条后台回复超过本地保存容量，刷新后可能丢失。请先切回写入或复制回复。`));
        }
        overview.append(element('span', 'pt-live-count', `${all.filter(s => stateOf(s, false).busy).length} 正在回复`), element('span', 'pt-ready-count', `${all.filter(s => s.unread).length} 待查看`));
        panel.append(overview);
        const section = element('div', 'pt-section-label', '对话'); section.append(element('span', '', `${sessions.size} / ${MAX_SESSIONS}`)); panel.append(section);
        const list = element('div', 'pt-session-list'); panel.append(list);
        if (!all.length) list.append(element('p', 'pt-muted', current().group ? '群聊暂不支持并行。打开一个单角色聊天后即可使用。' : '打开一个角色聊天后，这里会出现会话。'));
        if (curKey && !sessions.has(curKey)) list.append(element('p', 'pt-muted', `当前打开的对话不在这 ${MAX_SESSIONS} 个会话里，它的回复不能转入后台。关闭下面任意一个会话后，重新进入该对话即可加入。`));
        for (const session of all) {
            const here = session.key === curKey, status = stateOf(session), job = session.job;
            const card = element('div', `pt-card${here ? ' pt-active' : ''}`);
            // Keep the orbit phase when the panel rebuilds around cached faces.
            card.style.setProperty('--pt-orbit-delay', `${-((Date.now() - startedAt) % 12000)}ms`);
            card.dataset.session = session.key; card.dataset.busy = String(!!status.busy); card.dataset.unread = String(!!session.unread); card.dataset.state = status.state;
            const sessionRow = element('div', 'pt-session-row');
            const open = button('', () => void openSession(session), '切换到此会话'); open.classList.add('pt-session-open');
            const copy = element('span', 'pt-session-copy'), title = element('span', 'pt-title');
            title.append(element('span', 'pt-name', session.name));
            if (here) title.append(element('span', 'pt-current', '当前'));
            else if (session.unread) title.append(element('span', 'pt-completed', '新回复'));
            copy.append(title, element('span', 'pt-chat-name', session.chatId), element('span', 'pt-preview', preview(session).replace(/\s+/g, ' ') || '点击进入对话'), element('span', 'pt-status', status.label));
            open.append(stablePortrait('card:' + session.key, session), copy); sessionRow.append(open);
            const more = iconButton('会话操作', 'more', () => { controlsKey = controlsKey === session.key ? null : session.key; render(); });
            more.setAttribute('aria-expanded', String(controlsKey === session.key)); sessionRow.append(more); card.append(sessionRow);
            if (controlsKey === session.key) {
                const controls = element('div', 'pt-actions');
                if (status.busy) controls.append(button('停止生成', () => stopSession(session)));
                if (job && !job.attached && job.status !== 'running' && job.head && job.mismatch && here && markedIndex(job) >= 0) controls.append(button('直接写入原消息', () => void writeDirect(job)));
                if (job && !job.attached && job.status !== 'running' && job.head && job.bytes > 0) controls.append(button('复制回复', () => void copyJob(job)));
                if (job && !job.attached && !job.bgWritten) { const discard = confirmButton('丢弃回复', '再点一次确认丢弃', 'discard:' + session.key, () => drop(job, { abort: true })); discard.classList.add('pt-danger'); controls.append(discard); }
                if (job?.bgWritten && !here) controls.append(element('span', 'pt-muted', '回复已存入聊天，切回即可看'));
                if (!here) controls.append(job && !job.bgWritten ? confirmButton('关闭会话', job.status === 'running' ? '后台回复会被丢弃，再点确认' : '未写回的回复会被丢弃，再点确认', 'close:' + session.key, () => closeSession(session)) : button('关闭会话', () => closeSession(session)));
                if (!controls.childElementCount) controls.append(element('span', 'pt-muted', '这是当前对话'));
                card.append(controls);
            }
            list.append(card);
        }
        const footer = element('div', 'pt-footer');
        footer.append(button('退出并行', () => setEnabled(false)), element('span', '', `v${VERSION}`), button('设置', () => { menuOpen = !menuOpen; render(); })); panel.append(footer);
        if (menuOpen) {
            const menu = element('div', 'pt-menu');
            menu.append(button('收至左侧', () => dockLauncher('left')), button('收至右侧', () => dockLauncher('right')));
            const theme = button('夜间模式：' + (nightMode ? '开启' : '关闭'), () => setNightMode(!nightMode), '夜间模式');
            theme.setAttribute('role', 'switch'); theme.setAttribute('aria-checked', String(nightMode));
            const sound = button(`完成提示音：${soundEnabled ? '开启' : '关闭'}`, () => {
                soundEnabled = !soundEnabled;
                try { host.localStorage.setItem(soundKey, soundEnabled ? 'on' : 'off'); } catch { /* ignore */ }
                if (soundEnabled) unlockSound();
                render();
            }, '完成提示音');
            sound.setAttribute('role', 'switch'); sound.setAttribute('aria-checked', String(soundEnabled));
            const tips = element('details');
            tips.append(element('summary', '', '使用说明'), element('p', 'pt-muted', '发出消息后，从这里切到别的对话，原来的回复会在后台继续接收；切回时自动写入聊天。最多 3 个会话同时生成。刷新或退出页面会中断还没收完的回复，已收完但没写回的会保留。群聊与扩展自己发起的请求不转入后台。'));
            menu.append(theme, sound, button('复制诊断', () => void exportDiagnostics()), tips); panel.insertBefore(menu, footer);
        }
    }
    function refreshLive() {
        if (disposed || !isOn() || pointerActive || doc.hidden) return;
        // 有的宿主在聊天加载失败、或换了聊天却没发出“聊天已切换”事件时，这里补一次同步，
        // 否则插件会一直以为还停在上一份聊天。
        if (isOn() && !switching && !reattachBusy && current().key !== curKey) {
            log('chat:drift', { from: sid(curKey) });
            fgFinishedKey = null; gen = null; armed = null; building = null;
            chatSeenAt = Date.now();
            syncCurrent(); showPending(); updateHandoff(); queueRender(); scheduleReattach(50);
        }
        settle(); updateLauncher();
        if (!panelOpen || pickerOpen) return;
        for (const card of panel.querySelectorAll('.pt-card[data-session]')) {
            const session = sessions.get(card.dataset.session);
            if (!session) continue;
            const status = stateOf(session);
            if (card.dataset.state !== status.state) { render(); return; }
            const label = card.querySelector('.pt-status'); if (label && label.textContent !== status.label) label.textContent = status.label;
            const snippet = card.querySelector('.pt-preview'), text = preview(session).replace(/\s+/g, ' ') || '点击进入对话';
            if (snippet && snippet.textContent !== text) snippet.textContent = text;
        }
    }
    const liveTimer = host.setInterval(refreshLive, 1000);
    teardown.push(() => host.clearInterval(liveTimer));

    function chatTimestamp(value) {
        if (value == null || value === '') return 0;
        const number = Number(value), time = Number.isFinite(number) ? number : Date.parse(value);
        return Number.isFinite(time) && time > 0 ? time : 0;
    }
    function showPicker() {
        pickerOpen = true; panelOpen = true;
        picker.replaceChildren();
        const row = element('div', 'pt-row');
        row.append(element('span', 'pt-heading', '打开对话'), button('返回', () => { pickerOpen = false; render(); }));
        const search = element('input'); search.id = 'pt-search'; search.placeholder = '搜索角色名称'; search.setAttribute('aria-label', '搜索角色名称');
        const list = element('div'); list.id = 'pt-character-list';
        const fill = () => {
            list.replaceChildren();
            const filter = search.value.toLocaleLowerCase();
            const characters = ctx().characters.filter(c => c?.avatar && String(c.name || '').toLocaleLowerCase().includes(filter));
            characters.sort((a, b) => chatTimestamp(b.date_last_chat) - chatTimestamp(a.date_last_chat));
            for (const c of characters.slice(0, 120)) {
                const item = element('div', 'pt-character-choice');
                const recent = button('', () => void openSession({ avatar: c.avatar }), c.name);
                const copy = element('span', 'pt-character-copy', c.name);
                copy.append(element('span', 'pt-muted', '最近聊天'));
                recent.append(portrait(c), copy);
                const history = button('其他对话', () => void showHistory(c), `${c.name}的其他对话`);
                const arrow = element('span', 'pt-history-arrow', '→'); arrow.setAttribute('aria-hidden', 'true'); history.append(arrow);
                item.append(recent, history); list.append(item);
            }
            if (!characters.length) list.append(element('p', 'pt-muted', '没有匹配角色'));
            if (characters.length > 120) list.append(element('p', 'pt-muted', '仅显示前 120 个，请继续输入名称筛选。'));
            keepFloatingVisible();
        };
        search.addEventListener('input', fill);
        picker.append(row, search, list); fill(); render();
    }
    async function showHistory(character) {
        pickerOpen = true; panelOpen = true; picker.replaceChildren();
        const row = element('div', 'pt-row');
        row.append(element('span', 'pt-heading', character.name), button('返回', showPicker));
        const list = element('div'); list.id = 'pt-history-list';
        list.append(element('p', 'pt-muted', '正在读取聊天记录…')); picker.append(row, list); render();
        try {
            const response = await host.fetch('/api/characters/chats', {
                method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ avatar_url: character.avatar, ch_name: character.name }),
            });
            if (!response.ok) throw new Error(`读取聊天记录失败（HTTP ${response.status}）`);
            const data = await response.json();
            if (!data || data.error) throw new Error('酒馆没有返回聊天记录');
            if (!list.isConnected || !pickerOpen) return;
            const chats = Object.values(data).filter(x => x && typeof x.file_name === 'string');
            chats.sort((a, b) => String(b.last_mes || b.file_name).localeCompare(String(a.last_mes || a.file_name)));
            list.replaceChildren();
            for (const chat of chats) {
                const name = chat.file_name.replace(/\.jsonl$/i, '');
                const item = button('', () => void openSession({ avatar: character.avatar, chatId: name }), name);
                item.append(element('span', 'pt-history-name', name), element('span', 'pt-muted', `${chat.last_mes || ''}${chat.mes ? ' · ' + String(chat.mes).replace(/\s+/g, ' ').slice(-90) : ''}`));
                list.append(item);
            }
            if (!chats.length) list.append(element('p', 'pt-muted', '暂无其他聊天记录，可返回打开最近聊天。'));
            keepFloatingVisible();
        } catch (error) {
            if (!list.isConnected || !pickerOpen) return;
            list.replaceChildren(element('p', 'pt-error', shortError(error)), button('重试', () => void showHistory(character)));
        }
    }

    // 生成中直接点原生角色列表，酒馆会拒绝切换；这里接管成“转入后台再切换”。
    const captureCharacterClick = event => {
        if (!isOn()) return;
        const target = event.target?.closest?.('.character_select[data-chid], .character_select[chid]');
        if (!target) return;
        const character = ctx().characters[Number(target.dataset.chid ?? target.getAttribute('chid'))];
        if (!character?.avatar || (character.avatar === current().avatar && !switching)) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void openSession({ avatar: character.avatar });
    };
    doc.addEventListener('click', captureCharacterClick, true);
    teardown.push(() => doc.removeEventListener('click', captureCharacterClick, true));

    const noteSendIntent = event => {
        // A returned chat can still have a detached response waiting for the
        // scheduled native replay. Starting another manual generation here would
        // fall through intercept() as an untracked request and block switching.
        // Allow the replay trigger itself, but keep user actions waiting until
        // that original response is attached or explicitly handled.
        const wantsGeneration = event.type === 'click'
            ? event.target?.closest?.('#send_but, #option_regenerate, #option_continue, #mes_continue, #chat .swipe_right')
            : event.target?.id === 'send_textarea' && event.key === 'Enter' && !event.shiftKey && !event.isComposing;
        const job = isOn() ? sessions.get(current().key)?.job : null;
        const nativeReplayClick = event.type === 'click' && !event.isTrusted && !!replayArm && replayArm.job === job;
        if (wantsGeneration && !nativeReplayClick) {
            try { profile?.prepareSend?.(); }
            catch (error) { event.preventDefault(); event.stopImmediatePropagation(); notify(shortError(error)); return; }
        }
        if (wantsGeneration && !nativeReplayClick && (nativeSaveFailures.has(current().key) || job?.saveFailed || job?.awaitingNativeSave)) {
            event.preventDefault(); event.stopImmediatePropagation();
            const key = current().key;
            notify('这份回复尚未保存，正在重试保存；成功后可再次发送。');
            void saveCurrentChat(key).then(() => { settle(); queueRender(); }, error => notify('保存重试失败，回复已保留：' + shortError(error)));
            return;
        }
        if (wantsGeneration && isOn() && !nativeReplayClick && (switching || reattachBusy || job?.pendingDetach || (!isGenerating() && nativeStream()))) {
            event.preventDefault(); event.stopImmediatePropagation();
            log('send:blocked-handoff');
            notify('正在切换或处理回复，请稍后再发送；输入内容会保留。');
            return;
        }
        if (wantsGeneration && job && !job.attached && !nativeReplayClick) {
            event.preventDefault(); event.stopImmediatePropagation();
            log('send:blocked-pending-reply', { s: sid(job.key), replay: !!replayArm, mismatch: !!job.mismatch });
            if (!job.mismatch) {
                scheduleReattach(50);
                notify('这份聊天的后台回复正在接回，请稍后再发送；仍可切换其他会话。');
            } else notify('这份聊天的后台回复尚未处理，请先写入或丢弃；也可先复制备份，仍可切换其他会话。');
            return;
        }
        if (event.type === 'click' ? event.target?.closest?.('#send_but') : event.target?.id === 'send_textarea' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) sendIntentAt = Date.now();
    };
    doc.addEventListener('click', noteSendIntent, true);
    doc.addEventListener('keydown', noteSendIntent, true);
    teardown.push(() => { doc.removeEventListener('click', noteSendIntent, true); doc.removeEventListener('keydown', noteSendIntent, true); });

    const onVisible = () => { if (doc.hidden || disposed) return; log('page:visible'); settle(); render(); scheduleReattach(300); };
    doc.addEventListener('visibilitychange', onVisible);
    teardown.push(() => doc.removeEventListener('visibilitychange', onVisible));

    const warnUnload = event => {
        if (!canReload()) { event.preventDefault(); event.returnValue = ''; }
    };
    host.addEventListener('beforeunload', warnUnload);
    teardown.push(() => host.removeEventListener('beforeunload', warnUnload));

    function dispose() {
        if (disposed) return;
        disposed = true;
        for (const resolve of sleepResolvers) resolve(); sleepResolvers.clear();
        for (const id of timers) host.clearTimeout(id); timers.clear();
        cancelLater(reattachTimer); cancelLater(toastTimer); releaseReplay();
        for (const job of jobs.values()) if (job.status === 'running' && (!job.attached || job.pendingDetach)) { try { job.ac.abort(); } catch { /* ignore */ } }
        profile?.dispose?.();
        for (const clean of teardown.splice(0)) { try { clean(); } catch { /* 逐项隔离 */ } }
        if (host[KEY] === controller) delete host[KEY];
    }
    function canReload() {
        return !disposed && !switching && !pendingSwitch && !reattachBusy && !replayArm && !(armed && Date.now() <= armed.until) && !buildingNow()
            && !isGenerating() && !isSwiping() && !nativeStream() && nativeSaving?.() !== true && !profile?.blocked && !bgActive
            && ![...jobs.values()].some(job => job.status === 'running' || !job.bgWritten)
            && !nativeSaveChains.size && !nativeSaveFailures.size && !drafts.size && !doc.getElementById('send_textarea')?.value;
    }
    const controller = {
        version: VERSION, mode: 'low-memory', canReload, openSession,
        show() { if (launcherSide) expandLauncher(); panelOpen = true; pickerOpen = false; render(); },
        setLauncherVisible(value) { launcherVisible = value !== false; render(); },
        setNightMode,
        setEnabled,
        isEnabled: isOn,
        dispose,
        exportDiagnostics, diagnosticReport,
        getActiveWindow: () => host,
        diagnostics: () => ({ version: VERSION, current: curKey, readings: [...readings].map(([k, v]) => [k.slice(0, 24), v]), restoring: restoringUntil > Date.now(), generating: isGenerating(), armed: !!armed, replay: !!replayArm,
            sessions: [...sessions.values()].map(s => ({ name: s.name, chatId: s.chatId, unread: s.unread, job: s.job ? { type: s.job.type, status: s.job.status, attached: s.job.attached, bytes: s.job.bytes, created: s.job.created, mismatch: !!s.job.mismatch } : null })) }),
    };
    host[KEY] = controller;

    if (isOn()) restore();
    syncCurrent();
    try { profile = installProfiles?.(host, { busy: () => isGenerating() || !!replayArm || !!nativeStream() || nativeSaving?.() === true, notify, trace: log }) || null; } catch (error) { console.warn('[并行对话] 角色配置记忆未启用', error); }
    render();
    scheduleReattach(800);
    return controller;
}

