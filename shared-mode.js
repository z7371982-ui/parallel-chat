import { createSharedTaskEngine } from './shared-task-engine.js';
import { createSharedHostAdapter } from './shared-host-adapter.js';

// One native view, immutable network jobs, and conservative compatibility gates.
// This module never disables extensions, changes the theme, or creates an iframe.
export function installSharedMode(host, { controller, getExtensionState, onModeChange = () => {}, getCore, getOpenAI } = {}) {
    const doc = host.document;
    const context = () => host.SillyTavern.getContext();
    const loadCore = getCore || (() => import(new URL('script.js', host.location.href).href));
    const adapter = createSharedHostAdapter(host, { getContext: context, getCore: loadCore, getOpenAI, getExtensionState });
    const cards = new Map(), taskCards = new Map(), preparations = new Map(), taskErrors = new Map(), submittedInputs = new Map();
    let active = false, changing = false, stopped = false, surfaceLocked = false, preparing = false;
    let currentId = null, picker = false, coreModule = null, shouldSendOnEnter = null;
    const cleanups = [];
    const modes = { queued: '等待准备', preparing: '正在准备提示', executing: '后台生成中', commit_queued: '等待保存', committing: '正在保存', succeeded: '回复已保存', cancelled: '已取消', failed: '任务未完成' };
    const make = (tag, className, text) => {
        const node = doc.createElement(tag); node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (text, action, label = text) => {
        const node = make('button', 'pt-button', text); node.type = 'button';
        node.setAttribute('aria-label', label); node.addEventListener('click', () => { void Promise.resolve().then(action).catch(() => tell('操作未完成，请检查当前任务状态。')); });
        return node;
    };
    const tell = message => controller.notifyShared?.(message);
    const render = () => controller.refreshSharedView?.();
    const nativeBusy = () => coreModule?.is_send_press === true || coreModule?.isChatSaving === true || !!coreModule?.streamingProcessor;
    const input = () => doc.querySelector('#send_textarea');
    const sessionKey = ref => JSON.stringify([ref.avatar, ref.chatName]);
    function currentRef() {
        const c = context(), character = c.characters?.[c.characterId];
        const chatName = c.chatId ?? c.getCurrentChatId?.();
        if (c.groupId || !character?.avatar || !chatName) return null;
        return { avatar: character.avatar, chatName: String(chatName).replace(/\.jsonl$/i, ''), characterName: character.name };
    }
    function sameTarget(ref) { const current = currentRef(); return !!current && sessionKey(current) === sessionKey(ref); }
    function rememberCurrent() {
        const ref = currentRef();
        if (!ref) return null;
        const id = sessionKey(ref);
        let card = cards.get(id);
        if (!card) {
            if (cards.size >= 3) { currentId = null; return null; }
            card = { id, ref, title: ref.characterName, avatar: ref.avatar, chatId: ref.chatName, sharedTask: true, ready: true, busy: false, saving: false, status: '待命', draft: '', preview: '', unreadCompletion: false, taskId: null };
            cards.set(id, card);
        }
        card.preview = [...(context().chat || [])].reverse().find(message => !message.is_user && !message.is_system)?.mes?.slice(-240) || '';
        currentId = id;
        return card;
    }
    function captureDraft() {
        const card = cards.get(currentId);
        if (card && sameTarget(card.ref)) card.draft = input()?.value || '';
    }
    function restoreDraft(text) {
        const node = input();
        if (node) { node.value = text; node.dispatchEvent(new host.Event('input', { bubbles: true })); }
    }
    async function locked(action) {
        surfaceLocked = true;
        try { return await action(); }
        finally { surfaceLocked = false; render(); }
    }
    async function reloadIfCurrent(ref) {
        if (!sameTarget(ref)) return;
        const draft = input()?.value || '';
        // Reload the native message view so theme CSS and native message rendering
        // remain in charge. Do not emit a background result into another chat.
        await coreModule.reloadCurrentChat();
        if (sameTarget(ref)) restoreDraft(draft);
    }
    function safeTaskError(error, stage) {
        // Adapter errors are bounded fixed user-facing messages; never expose raw
        // transport errors, provider payloads, credentials, or error stacks.
        return typeof error?.code === 'string' && error.code.startsWith('SHARED_')
            ? String(error.message).slice(0, 500)
            : stage === 'execute' ? '请求失败，用户消息已保留；请检查连接后再操作。'
                : stage === 'commit' ? '保存未确认；生成结果已保留，请先复制结果或重试保存。'
                    : '提示准备未完成，请检查当前聊天。';
    }
    const engine = createSharedTaskEngine({
        prepare: async (ref, message, { taskId, signal }) => locked(async () => {
            preparing = true;
            try {
                if (!active || !sameTarget(ref)) throw Object.assign(new Error('发送前当前聊天已改变，请返回原聊天重新发送。'), { code: 'SHARED_CONTEXT_CHANGED' });
                const prepared = await adapter.prepare({ ...ref, text: message, signal });
                const submitted = submittedInputs.get(taskId); if (submitted) submitted.added = true;
                preparations.set(taskId, prepared);
                return prepared;
            } catch (error) {
                const submitted = submittedInputs.get(taskId); if (submitted) submitted.added = error.userMessageAdded === true;
                taskErrors.set(taskId, safeTaskError(error, 'prepare') + (error.userMessageAdded ? ' 用户消息已经加入聊天，请勿重复发送相同内容。' : ''));
                throw error;
            } finally { preparing = false; }
        }),
        execute: async (snapshot, options) => {
            try { return await adapter.execute(snapshot, options); }
            catch (error) { taskErrors.set(options.taskId, safeTaskError(error, 'execute')); throw error; }
        },
        commit: async (snapshot, result, { taskId }) => locked(async () => {
            try {
                const saved = await adapter.commit(snapshot, result);
                try { await reloadIfCurrent(snapshot.target); }
                catch { tell('回复已保存，但当前页面刷新未完成。请重新打开此聊天查看。'); }
                return saved;
            } catch (error) { taskErrors.set(taskId, safeTaskError(error, 'commit')); throw error; }
        }),
        onChange: task => {
            // submit() reports its queued state before it returns the task ID.
            // Apply in a microtask after the UI has installed the ownership map.
            host.queueMicrotask(() => updateTask(task));
        },
    });
    function updateTask(task) {
        const card = cards.get(taskCards.get(task.taskId));
        if (!card || card.taskId !== task.taskId) return;
        const latest = engine.getTask(task.taskId);
        if (!latest) return;
        card.busy = latest.pending && !['committing', 'commit_queued'].includes(latest.status);
        card.saving = latest.pending && ['committing', 'commit_queued'].includes(latest.status);
        card.status = modes[latest.status] || '待命';
        if (latest.status === 'failed') card.status = taskErrors.get(latest.taskId) || '任务失败；没有自动重发请求。';
        if (!latest.pending && ['failed', 'cancelled'].includes(latest.status)) {
            const submitted = submittedInputs.get(latest.taskId);
            if (submitted && !submitted.added) {
                card.recoveredInput = submitted.text;
                if (sameTarget(card.ref) && !input()?.value) {
                    restoreDraft(submitted.text); card.draft = submitted.text; card.recoveredInput = null;
                } else if (!card.draft && !sameTarget(card.ref)) {
                    card.draft = submitted.text; card.recoveredInput = null;
                }
            }
        }
        if (!latest.pending) submittedInputs.delete(latest.taskId);
        if (latest.status === 'succeeded' && !card.notified) {
            card.notified = true; card.unreadCompletion = currentId !== card.id;
            card.preview = engine.getResult(latest.taskId)?.text?.slice(-240) || card.preview;
            tell(`${card.title} 的回复已保存。`);
        }
        // Successful/cancelled jobs can release prompts and response bodies.
        // Failed saves retain both the result and the exact commit baseline.
        if (!latest.pending && ['succeeded', 'cancelled'].includes(latest.status)) releasePrepared(latest.taskId);
        render();
    }
    function releasePrepared(taskId) {
        const prepared = preparations.get(taskId);
        if (prepared) { try { adapter.release(prepared.id); } catch {} preparations.delete(taskId); }
    }
    function forget(card) {
        if (!card.taskId) return;
        releasePrepared(card.taskId); engine.forgetTask(card.taskId);
        taskCards.delete(card.taskId); taskErrors.delete(card.taskId); submittedInputs.delete(card.taskId); card.taskId = null;
    }
    function submit() {
        if (!active) return;
        if (surfaceLocked || engine.hasHostWork() || nativeBusy()) return tell('正在准备、保存或切换聊天，请稍后发送。');
        const card = rememberCurrent(), text = input()?.value || '';
        if (!card && cards.size >= 3) return tell('共享实验最多管理三个聊天，请先关闭一个已完成的卡片。');
        if (!card || !text.trim()) return tell('请先打开角色并输入普通文本消息。');
        if (text.trimStart().startsWith('/')) return tell('共享实验暂不执行斜杠命令，请关闭此模式后使用。');
        if (card.taskId) {
            const previous = engine.getTask(card.taskId);
            if (previous?.pending) return tell('这个聊天仍有任务，请等待或单独停止。');
            if (previous?.hasResult && previous.status !== 'succeeded') return tell('上一条生成结果尚未保存。请先复制、重试保存或明确放弃结果。');
            forget(card);
        }
        card.notified = false; card.unreadCompletion = false;
        const taskId = engine.submit(card.ref, text);
        card.taskId = taskId; taskCards.set(taskId, card.id);
        submittedInputs.set(taskId, { text, added: false });
        card.draft = ''; restoreDraft(''); render();
    }
    async function activate(id) {
        if (!active) return;
        if (surfaceLocked || engine.hasHostWork() || nativeBusy()) return tell('正在准备或保存聊天，请稍后切换。');
        const card = cards.get(id); if (!card) return;
        captureDraft();
        await engine.runExclusive(() => locked(async () => {
            if (!sameTarget(card.ref)) {
                const index = context().characters.findIndex(character => character.avatar === card.ref.avatar);
                if (index < 0) throw new Error('Character unavailable');
                await context().selectCharacterById(String(index), { chatFile: card.ref.chatName });
                if (!sameTarget(card.ref) && typeof coreModule.openCharacterChat === 'function') await coreModule.openCharacterChat(card.ref.chatName);
                if (!sameTarget(card.ref)) throw new Error('Chat selection failed');
            }
            currentId = card.id; card.unreadCompletion = false;
            restoreDraft(card.draft); picker = false;
        }));
        controller.hideSharedPanel?.();
        render();
    }
    async function openCharacter(avatar) {
        if (!active || surfaceLocked || engine.hasHostWork() || nativeBusy()) return tell('正在准备、保存或切换聊天，请稍后再试。');
        const character = context().characters.find(item => item.avatar === avatar);
        if (!character) return;
        const existing = [...cards.values()].find(card => card.avatar === avatar);
        if (existing) return activate(existing.id);
        if (cards.size >= 3) return tell('实验版最多管理三个聊天，请先关闭一个已完成的任务卡片。');
        captureDraft();
        await engine.runExclusive(() => locked(async () => {
            const index = context().characters.findIndex(item => item.avatar === avatar);
            await context().selectCharacterById(String(index));
            if (currentRef()?.avatar !== avatar) throw new Error('Character selection failed');
            const card = rememberCurrent();
            if (!card) throw new Error('Chat not ready');
            restoreDraft(card.draft); picker = false;
        }));
        controller.hideSharedPanel?.();
        render();
    }
    async function copyResult(card) {
        const result = engine.getResult(card.taskId);
        if (!result?.text) return tell('此任务没有可复制的生成结果。');
        try { await host.navigator.clipboard.writeText(result.text); tell('已复制生成结果。'); }
        catch {
            const dialog = doc.createElement('dialog');
            const area = doc.createElement('textarea'); area.readOnly = true; area.value = result.text;
            area.setAttribute('aria-label', '未保存的生成结果'); area.style.cssText = 'width:min(75vw,700px);height:50vh';
            dialog.append(area, button('关闭', () => { dialog.close(); dialog.remove(); })); doc.body.append(dialog);
            dialog.showModal(); area.focus(); area.select();
        }
    }
    function renderPicker(panel) {
        if (panel.querySelector('#pt-shared-picker')) return;
        panel.replaceChildren();
        const root = make('div', '', ''); root.id = 'pt-shared-picker';
        const row = make('div', 'pt-row'); row.append(make('span', 'pt-heading', '打开对话'), button('返回', () => { picker = false; render(); }));
        const search = make('input', '', ''); search.id = 'pt-search'; search.placeholder = '搜索角色名称'; search.setAttribute('aria-label', '搜索角色名称');
        const list = make('div', ''); list.id = 'pt-character-list';
        const fill = () => {
            list.replaceChildren();
            for (const character of context().characters.filter(item => item?.avatar && item.name?.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).slice(0, 120)) {
                const choice = make('div', 'pt-character-choice'); choice.append(button(character.name, () => openCharacter(character.avatar), character.name)); list.append(choice);
            }
        };
        search.addEventListener('input', fill); root.append(row, search, list); panel.append(root); fill();
    }
    function renderPanel(panel) {
        if (picker) return renderPicker(panel);
        panel.replaceChildren();
        const row = make('div', 'pt-row'), title = make('span', 'pt-heading', 'Parallel');
        title.append(make('span', 'pt-subheading', '共享任务 · 实验'));
        row.append(title, button('＋ 打开对话', () => { picker = true; render(); }, '打开对话')); panel.append(row);
        const explanation = make('p', 'pt-muted', '共用当前酒馆页面与美化；普通文本回复完成后显示。切卡不停止已发出的任务。');
        explanation.style.padding = '0 20px'; panel.append(explanation);
        const list = make('div', 'pt-session-list'); panel.append(list);
        for (const card of cards.values()) {
            const node = make('div', `pt-card${currentId === card.id ? ' pt-active' : ''}`); node.dataset.session = card.id;
            const open = button('', () => activate(card.id), '查看此会话'); open.classList.add('pt-session-open');
            const portrait = make('span', 'pt-portrait', [...card.title][0] || '聊');
            const copy = make('span', 'pt-session-copy');
            copy.append(make('span', 'pt-name', card.title), make('span', 'pt-chat-name', card.chatId), make('span', 'pt-preview', card.preview), make('span', 'pt-status', card.status));
            open.append(portrait, copy); node.append(open);
            const actions = make('div', 'pt-actions'), task = card.taskId && engine.getTask(card.taskId);
            if (card.recoveredInput) actions.append(button('恢复未发送内容', () => {
                if (!sameTarget(card.ref)) return tell('请先切回此聊天再恢复输入。');
                if (input()?.value && !host.confirm('替换当前输入框里的草稿，恢复这次未发送的内容？')) return;
                restoreDraft(card.recoveredInput); card.draft = card.recoveredInput; card.recoveredInput = null; render();
            }));
            if (task?.pending) {
                const stop = button('停止此任务', () => { if (!engine.cancel(card.taskId)) tell('已经开始保存，请等待保存完成。'); }); stop.disabled = task.commitStarted; actions.append(stop);
            } else if (task?.hasResult && task.status !== 'succeeded') {
                actions.append(button('复制未保存回复', () => copyResult(card)));
                if (task.canRetryCommit) actions.append(button('重试保存', () => engine.retryCommit(card.taskId)));
                actions.append(button('放弃结果', () => { if (host.confirm('放弃这条尚未保存的回复？不会删除已有聊天。')) { forget(card); card.status = '待命'; render(); } }));
            }
            if (currentId !== card.id && !task?.pending && !(task?.hasResult && task.status !== 'succeeded')) actions.append(button('关闭卡片', () => {
                if ((card.draft || card.recoveredInput) && !host.confirm('此卡片还有未发送内容，仍然关闭并丢弃草稿？')) return;
                forget(card); cards.delete(card.id); render();
            }));
            if (actions.childElementCount) node.append(actions);
            list.append(node);
        }
        const footer = make('div', 'pt-footer'); footer.append(make('span', '', '保持此页面开启'), button('关闭共享模式', async () => {
            const result = await setEnabled(false); if (!result.enabled) onModeChange(false); else tell(result.reasons.join('；'));
        })); panel.append(footer);
    }
    const unresolved = () => engine.listTasks().some(task => task.hasResult && task.status !== 'succeeded')
        || [...cards.values()].some(card => card.recoveredInput || (card.id !== currentId && card.draft));
    const view = { get active() { return active; }, render: renderPanel, sessions: () => [...cards.values()], activate,
        busy: () => engine.hasPending() || engine.hasHostWork() || unresolved(), dispose: () => dispose() };
    async function setEnabled(value) {
        value = value === true;
        if (changing || stopped) return { enabled: active, reasons: ['正在切换模式，请稍后操作。'] };
        if (value === active) return { enabled: active, reasons: [] };
        changing = true;
        try {
            if (value) {
                const state = controller.diagnostics();
                if (!state.appReady || state.sessions.length !== 1 || state.sessions.some(session => session.busy)) return { enabled: false, reasons: ['请先等待酒馆就绪并关闭其他完整会话，再开启共享实验。'] };
                coreModule = await loadCore();
                const keyboard = await import(new URL('scripts/RossAscends-mods.js', host.location.href).href);
                shouldSendOnEnter = keyboard.shouldSendOnEnter;
                if (typeof shouldSendOnEnter !== 'function') return { enabled: false, reasons: ['此宿主缺少原生回车发送设置接口。'] };
                if (typeof coreModule.reloadCurrentChat !== 'function' || typeof context().selectCharacterById !== 'function') return { enabled: false, reasons: ['此宿主缺少安全切换及刷新当前聊天的接口。'] };
                const report = await adapter.probe();
                if (!report.supported) return { enabled: false, reasons: report.reasons };
                if (!currentRef() || nativeBusy()) return { enabled: false, reasons: ['请先打开一个已有记录的单角色聊天，等待生成和保存结束。'] };
                active = true; rememberCurrent();
                if (controller.setSharedView(view) === false) { active = false; cards.clear(); currentId = null; return { enabled: false, reasons: ['主页面状态已改变，未开启共享实验。'] }; }
                return { enabled: true, reasons: [] };
            }
            if (engine.hasPending() || engine.hasHostWork()) return { enabled: true, reasons: ['仍有生成、保存或页面操作，请完成或停止任务后再关闭。'] };
            if (engine.listTasks().some(task => task.hasResult && task.status !== 'succeeded')) return { enabled: true, reasons: ['仍有未保存的回复，请先复制、重试保存或放弃结果。'] };
            if ([...cards.values()].some(card => card.recoveredInput || (card.id !== currentId && card.draft))) return { enabled: true, reasons: ['其他角色仍有草稿，请先切回处理后再关闭共享模式。'] };
            active = false; picker = false;
            for (const card of cards.values()) forget(card);
            cards.clear(); currentId = null; controller.setSharedView(null);
            return { enabled: false, reasons: [] };
        } finally { changing = false; render(); }
    }
    const prevent = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const blockWhileLocked = event => {
        if (!active || !(surfaceLocked || engine.hasHostWork()) || !event.isTrusted) return;
        if (event.target?.closest?.('#pt-panel,#pt-launcher,#pt-completion-badge')) return;
        prevent(event);
        if (event.type === 'click') tell('正在准备或保存聊天，请稍候。后台请求发出后可以自由切换。');
    };
    for (const name of ['pointerdown', 'click', 'keydown', 'beforeinput']) {
        host.addEventListener(name, blockWhileLocked, true);
        cleanups.push(() => host.removeEventListener(name, blockWhileLocked, true));
    }
    const click = event => {
        if (!active) return;
        if (event.target?.closest?.('#option_regenerate,#option_continue,#option_impersonate,.swipe_right')) {
            prevent(event); tell('共享实验暂只接管普通文本发送，使用重生成或续写前请关闭共享模式。'); return;
        }
        const target = event.target?.closest?.('#send_but,.character_select[data-chid],.group_select');
        if (!target) return;
        prevent(event);
        if (target.id === 'send_but') submit();
        else if (target.matches('.group_select')) tell('共享实验仅支持单角色聊天。');
        else { const char = context().characters[Number(target.dataset.chid)]; if (char) void openCharacter(char.avatar).catch(() => tell('角色切换未完成，请检查当前聊天。')); }
    };
    const keydown = event => {
        if (!active || event.key !== 'Enter' || event.isComposing) return;
        if (event.ctrlKey || event.altKey) { prevent(event); tell('共享模式使用普通发送按钮；重生成、续写快捷键请在完整模式使用。'); return; }
        if (event.target?.id !== 'send_textarea' || event.shiftKey || !shouldSendOnEnter?.()) return;
        prevent(event); submit();
    };
    host.addEventListener('click', click, true); host.addEventListener('keydown', keydown, true);
    cleanups.push(() => { host.removeEventListener('click', click, true); host.removeEventListener('keydown', keydown, true); });
    const trackDraft = event => { if (active && event.target?.id === 'send_textarea') captureDraft(); };
    doc.addEventListener('input', trackDraft, true);
    cleanups.push(() => doc.removeEventListener('input', trackDraft, true));
    const c = context(), events = c.eventTypes || c.event_types;
    const on = (name, callback) => {
        if (!name) return;
        c.eventSource.on(name, callback);
        cleanups.push(() => c.eventSource.removeListener ? c.eventSource.removeListener(name, callback) : c.eventSource.off(name, callback));
    };
    on(events.CHAT_CHANGED, () => {
        if (!active || surfaceLocked) return;
        // Native history menus may change the visible chat too; associate the
        // actual new identity rather than silently reusing an old task target.
        const card = rememberCurrent(); if (card) restoreDraft(card.draft); render();
    });
    function dispose() {
        if (engine.hasPending() || engine.hasHostWork() || unresolved()) return false;
        stopped = true; active = false;
        for (const card of cards.values()) forget(card);
        cards.clear(); cleanups.splice(0).forEach(clean => clean()); return true;
    }
    return { setEnabled, dispose, diagnostics: () => ({ enabled: active, tasks: engine.listTasks(), sessions: cards.size, surfaceBusy: surfaceLocked }) };
}
