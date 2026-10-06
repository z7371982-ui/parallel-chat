// Experimental fixed-request adapter. Prompt preparation uses the visible native
// chat under the caller's UI lock. Network execution never swaps native globals.
// Background commits deliberately do not emit current-chat message events.
// The server's /api/chats/save endpoint has no content-version CAS: a fresh read
// detects conflicts, but another client can still write between our read/save.

const SOURCES = new Set(['openai', 'custom']);
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function checkAbort(signal) {
    if (signal?.aborted) throw failure('SHARED_ABORTED', '共享任务已取消。');
}

function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

function fingerprint(text) {
    // Full canonical contents are compared too; this hash is not a CAS token.
    // No SubtleCrypto requirement, so LAN HTTP installations remain supported.
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function persistedMetadata(value) {
    const metadata = clone(value || {});
    delete metadata.lastInContextMessageId;
    return metadata;
}

function assertTextMessages(messages) {
    if (!Array.isArray(messages) || !messages.length || messages.some(message =>
        !object(message) || !['system', 'user', 'assistant'].includes(message.role)
        || typeof message.content !== 'string' || message.tool_calls || message.function_call
        || message.images || message.audio)) {
        throw failure('SHARED_UNSUPPORTED_PROMPT', '共享实验仅支持纯文本提示；工具或多模态会话需要完整模式。');
    }
}

function assertPayload(payload) {
    if (!object(payload) || !SOURCES.has(payload.chat_completion_source)
        || typeof payload.model !== 'string' || !payload.model.trim()
        || (payload.custom_api_format !== undefined && payload.custom_api_format !== 'openai_compat')
        || payload.stream !== false || (payload.n !== undefined && payload.n !== 1)
        || (Array.isArray(payload.tools) ? payload.tools.length > 0 : !!payload.tools)
        || payload.functions || payload.function_call || payload.json_schema
        || (payload.tool_choice && payload.tool_choice !== 'none')) {
        throw failure('SHARED_UNSUPPORTED_REQUEST', '此请求需要完整模式：共享实验仅支持 OpenAI/自定义、单条非流式纯文本回复。');
    }
    assertTextMessages(payload.messages);
}

function assertHistory(payload) {
    if (!Array.isArray(payload) || payload.length < 2 || !object(payload[0])
        || !object(payload[0].chat_metadata) || payload.slice(1).some(message =>
            !object(message) || typeof message.mes !== 'string' || typeof message.is_user !== 'boolean')) {
        throw failure('SHARED_INVALID_HISTORY', '无法完整验证目标聊天记录，已停止共享任务。');
    }
    return payload;
}

/**
 * Dependencies may return promises. getExtensionState must return a real checked
 * inventory: { known: true, manifests: Record<string, Manifest>, settings:
 * extension_settings, selfExtensionId: string }. Only the connection-manager
 * built-in and stylesheet-only extensions are certified here. An optional
 * unsupportedFeatures list can report host/card capabilities outside manifests.
 * Unknown/unsupported installations use the existing complete runtime instead.
 * The caller locks native send/navigation for prepare and commit and reloads an
 * active target only after commit succeeds. Never automatically resend text when
 * a prepare error has userMessageAdded=true.
 */
export function createSharedHostAdapter(host, {
    getContext = () => host.SillyTavern?.getContext?.(),
    getCore = () => import(new URL('script.js', host.location.href).href),
    getOpenAI = () => import(new URL('scripts/openai.js', host.location.href).href),
    getExtensionState,
} = {}) {
    const records = new Map();
    let surfaceBusy = false;
    let sequence = 0;

    function targetOf(context) {
        const character = context?.characters?.[context.characterId];
        const chatName = context?.chatId ?? context?.getCurrentChatId?.();
        if (context?.groupId || !character?.avatar || !character.name || !chatName) {
            throw failure('SHARED_NO_TARGET', '请先在主页面打开一个有聊天记录的单角色会话。');
        }
        return { avatar: character.avatar, characterName: character.name, chatName: String(chatName).replace(/\.jsonl$/i, '') };
    }

    function assertTarget(target) {
        const current = targetOf(getContext());
        if (current.avatar !== target.avatar || current.chatName !== target.chatName) {
            throw failure('SHARED_CONTEXT_CHANGED', '准备期间当前聊天发生变化，已停止共享任务。');
        }
        return getContext();
    }

    async function capabilities() {
        const [core, openai, extensionState] = await Promise.all([
            getCore(), getOpenAI(), typeof getExtensionState === 'function' ? getExtensionState() : null,
        ]);
        const context = getContext();
        const reasons = [];
        if (!extensionState?.known || !object(extensionState.manifests)
            || !Array.isArray(extensionState.settings?.disabledExtensions)) reasons.push('无法确认扩展兼容情况');
        else {
            const disabled = new Set(extensionState.settings.disabledExtensions);
            const ownManifest = extensionState.manifests[extensionState.selfExtensionId];
            const ownGuardReady = ownManifest?.generate_interceptor === 'parallelChatSharedGenerationGuard'
                && typeof host.parallelChatSharedGenerationGuard === 'function'
                && host.parallelChatSharedGenerationGuard.__ptSharedGuard === true;
            if (!ownGuardReady) reasons.push('共享生成保护未完整加载，请更新扩展 manifest.json 并刷新酒馆');
            for (const [id, manifest] of Object.entries(extensionState.manifests)) {
                if (!object(manifest)) { reasons.push('存在无法识别的扩展清单'); continue; }
                const isOwnGuard = id === extensionState.selfExtensionId && ownGuardReady;
                // A disabled extension can still have a loaded interceptor until
                // the host reloads. The native runner checks the global function.
                if (manifest.generate_interceptor && !isOwnGuard
                    && (!disabled.has(id) || typeof host[manifest.generate_interceptor] === 'function')) {
                    reasons.push(`存在生成拦截器：${id}`);
                }
                if (disabled.has(id) || id === extensionState.selfExtensionId) continue;
                if (id.startsWith('third-party/') && manifest.js) reasons.push(`第三方扩展尚未适配共享任务：${id}`);
                else if (manifest.js && id !== 'connection-manager') reasons.push(`内置扩展尚未适配共享任务：${id}`);
            }
            if (Array.isArray(extensionState.unsupportedFeatures)) reasons.push(...extensionState.unsupportedFeatures);
        }
        const settings = openai?.oai_settings || context?.chatCompletionSettings;
        if (context?.mainApi !== 'openai' || !SOURCES.has(settings?.chat_completion_source)) reasons.push('仅支持 OpenAI 或自定义聊天完成来源');
        if (settings?.chat_completion_source === 'custom' && settings.custom_api_format !== undefined && settings.custom_api_format !== 'openai_compat') {
            reasons.push('此自定义接口不是 OpenAI Chat Completions 格式');
        }
        if (Number(settings?.n ?? 1) !== 1) reasons.push('多候选回复需要完整模式');
        if (settings?.function_calling) reasons.push('工具调用需要完整模式');
        for (const name of ['Generate', 'sendMessageAsUser', 'saveChat']) {
            if (typeof core?.[name] !== 'function') reasons.push(`宿主缺少 ${name}`);
        }
        for (const name of ['createGenerationParameters', 'getChatCompletionModel']) {
            if (typeof openai?.[name] !== 'function') reasons.push(`宿主缺少 ${name}`);
        }
        const events = context?.eventTypes || context?.event_types || core?.event_types;
        const emitter = context?.eventSource || core?.eventSource;
        if (!events?.GENERATE_AFTER_DATA || !events?.CHAT_COMPLETION_SETTINGS_READY
            || typeof emitter?.on !== 'function' || typeof emitter?.emit !== 'function'
            || (typeof emitter?.removeListener !== 'function' && typeof emitter?.off !== 'function')) reasons.push('宿主缺少提示准备事件接口');
        if (typeof context?.ChatCompletionService?.sendRequest !== 'function') reasons.push('宿主缺少独立请求接口');
        if (typeof context?.getRequestHeaders !== 'function' || typeof host.fetch !== 'function') reasons.push('宿主缺少聊天存档接口');
        return { core, openai, context, settings, events, emitter, reasons };
    }

    async function probe() {
        try {
            const { reasons } = await capabilities();
            return { supported: reasons.length === 0, reasons };
        } catch {
            return { supported: false, reasons: ['无法读取宿主共享任务接口，请使用完整模式'] };
        }
    }

    async function chatRequest(route, target, body, signal) {
        checkAbort(signal);
        const context = getContext();
        const response = await host.fetch(new URL(`api/chats/${route}`, host.location.href).href, {
            method: 'POST', headers: context.getRequestHeaders(), signal,
            body: JSON.stringify({ avatar_url: target.avatar, ch_name: target.characterName, file_name: target.chatName, ...body }),
        });
        let payload;
        try { payload = await response.json(); }
        catch { throw failure('SHARED_STORAGE_RESPONSE', '聊天存档接口返回了无法识别的数据。'); }
        if (!response.ok || payload?.error) throw failure('SHARED_STORAGE_FAILED', route === 'save' ? '保存失败；生成结果已保留，请勿重复发送。' : '读取目标聊天失败，已停止保存。');
        checkAbort(signal);
        return payload;
    }

    async function readChat(target, signal) {
        return assertHistory(await chatRequest('get', target, {}, signal));
    }

    function recordOf(prepared) {
        const record = records.get(typeof prepared === 'string' ? prepared : prepared?.id);
        if (!record) throw failure('SHARED_UNKNOWN_TASK', '共享任务已失效，请重新检查当前会话。');
        return record;
    }

    async function prepare({ avatar, chatName, text, signal } = {}) {
        if (surfaceBusy) throw failure('SHARED_SURFACE_BUSY', '另一个共享任务正在准备或保存，请稍后再试。');
        if (typeof text !== 'string' || !text.trim()) throw failure('SHARED_EMPTY_INPUT', '请输入消息。');
        checkAbort(signal);
        surfaceBusy = true;
        let target, userMessageAdded = false;
        try {
            const { core, openai, context, settings, events, emitter, reasons } = await capabilities();
            if (reasons.length) throw failure('SHARED_UNSUPPORTED', reasons.join('；'));
            const inputBias = typeof core.extractMessageBias === 'function' ? core.extractMessageBias(text) : '';
            if (inputBias || /\{\{\s*bias\b/i.test(text)) {
                throw failure('SHARED_UNSUPPORTED_INPUT', '输入 bias 宏尚未适配共享实验，请关闭共享模式后发送。');
            }
            // ST/TT populateFileAttachment and hasPendingFileAttachment read
            // this exact input. Check before sendMessageAsUser can upload it.
            const pendingFile = typeof core.hasPendingFileAttachment === 'function' && core.hasPendingFileAttachment();
            if (pendingFile || host.document?.getElementById?.('file_form_input')?.files?.length > 0) {
                throw failure('SHARED_UNSUPPORTED_INPUT', '待发送附件需要完整模式；尚未发送本条消息，请关闭共享模式后发送。');
            }
            if (core.is_send_press || core.isChatSaving || core.streamingProcessor || host.document?.body?.dataset?.generating === 'true') {
                throw failure('SHARED_NATIVE_BUSY', core.streamingProcessor && !core.is_send_press && !core.isChatSaving
                    ? '上一轮原生流尚未完整收尾；请等待，若持续不恢复则刷新后重试。'
                    : '主页面仍在生成或保存，请结束后再准备共享任务。');
            }
            target = targetOf(context);
            if ((avatar && target.avatar !== avatar) || (chatName && target.chatName !== String(chatName).replace(/\.jsonl$/i, ''))) {
                throw failure('SHARED_CONTEXT_CHANGED', '请求的角色或聊天不是主页面当前会话。');
            }
            const sourceSettings = canonical(clone(settings));
            const frozenSettings = clone(settings);
            frozenSettings.stream_openai = false;
            const model = openai.getChatCompletionModel(frozenSettings);
            const initialLength = context.chat.length;
            checkAbort(signal); assertTarget(target);
            try { await core.sendMessageAsUser(text); }
            finally {
                try { userMessageAdded = assertTarget(target).chat.length > initialLength; }
                catch { userMessageAdded = true; }
            }
            checkAbort(signal); assertTarget(target);
            await core.saveChat({});
            checkAbort(signal); assertTarget(target);

            let captured = null, captureCount = 0;
            const listener = (data, dryRun) => {
                if (dryRun === true) { captured = data; captureCount++; }
            };
            emitter.on(events.GENERATE_AFTER_DATA, listener);
            try { await core.Generate('normal', {}, true); }
            finally {
                if (typeof emitter.removeListener === 'function') emitter.removeListener(events.GENERATE_AFTER_DATA, listener);
                else emitter.off(events.GENERATE_AFTER_DATA, listener);
            }
            checkAbort(signal); assertTarget(target);
            if (captureCount !== 1 || !captured) throw failure('SHARED_PROMPT_CAPTURE', '未能唯一捕获原生提示，已停止共享任务。');
            assertTextMessages(captured.prompt);
            const messages = clone(captured.prompt);
            // Mirrors native sendOpenAIRequest's parameter builder and final
            // request hook. Never substitute a hand-written character prompt.
            const built = await openai.createGenerationParameters(frozenSettings, model, 'normal', messages, { jsonSchema: null });
            checkAbort(signal); assertTarget(target);
            if (built?.canMultiSwipe || built?.stream !== false) throw failure('SHARED_UNSUPPORTED_REQUEST', '宿主未生成单条非流式请求，已停止共享任务。');
            await emitter.emit(events.CHAT_COMPLETION_SETTINGS_READY, built.generate_data);
            checkAbort(signal); assertTarget(target);
            if (canonical(clone(openai.oai_settings || getContext().chatCompletionSettings)) !== sourceSettings) {
                throw failure('SHARED_SETTINGS_CHANGED', '准备期间模型或预设发生变化，已停止共享任务。');
            }
            const payload = clone(built.generate_data);
            assertPayload(payload);
            // Prompt macros can update chat metadata. Persist those native
            // changes before taking the exact conflict-detection baseline.
            await core.saveChat({});
            checkAbort(signal); assertTarget(target);
            const base = clone(await readChat(target, signal));
            const latest = assertTarget(target);
            if (canonical(clone(latest.chat)) !== canonical(base.slice(1))) {
                throw failure('SHARED_CONTEXT_CHANGED', '内存消息与已保存聊天不一致，已停止共享任务。');
            }
            const baseText = canonical(base);
            const nonce = host.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${++sequence}`;
            const prepared = Object.freeze({ id: `shared-${nonce}`,
                target: Object.freeze({ ...target }), model: payload.model,
                source: payload.chat_completion_source, createdAt: Date.now(), baseHash: fingerprint(baseText) });
            records.set(prepared.id, { prepared, payload, base, baseText, baseHash: prepared.baseHash,
                sendRequest: context.ChatCompletionService.sendRequest.bind(context.ChatCompletionService),
                state: 'prepared', result: null, finalPayload: null });
            return prepared;
        } catch (error) {
            if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
                error = failure('SHARED_PREPARE_FAILED', '宿主提示准备失败，请检查已发送的用户消息。');
            }
            error.userMessageAdded = userMessageAdded;
            if (target) error.target = { ...target };
            throw error;
        } finally { surfaceBusy = false; }
    }

    async function execute(prepared, { signal } = {}) {
        const record = recordOf(prepared);
        prepared = record.prepared;
        if (record.state !== 'prepared') throw failure('SHARED_TASK_STATE', '此任务已开始执行，不能重复发送。');
        checkAbort(signal);
        record.state = 'running';
        const startedAt = Date.now();
        try {
            const raw = await record.sendRequest(clone(record.payload), false, signal);
            checkAbort(signal);
            const message = raw?.choices?.[0]?.message;
            if (raw?.error || !Array.isArray(raw?.choices) || raw.choices.length !== 1
                || !object(message) || typeof message.content !== 'string' || !message.content.trim()
                || message.tool_calls || message.function_call || message.images || message.audio) {
                throw failure('SHARED_UNSUPPORTED_RESPONSE', '接口返回了非文本或工具结果；未写入聊天记录。');
            }
            const reasoning = message.reasoning_content ?? message.reasoning ?? '';
            if (typeof reasoning !== 'string') throw failure('SHARED_UNSUPPORTED_RESPONSE', '接口返回了无法识别的推理数据；未写入聊天记录。');
            const result = Object.freeze({ preparedId: prepared.id, text: message.content, reasoning, startedAt, finishedAt: Date.now() });
            record.result = result; record.state = 'generated';
            return result;
        } catch (error) { record.state = 'failed'; throw error; }
    }

    async function commit(prepared, result, { signal } = {}) {
        const record = recordOf(prepared);
        prepared = record.prepared;
        if (!record.result || canonical(record.result) !== canonical(result) || !['generated', 'committed'].includes(record.state)) {
            throw failure('SHARED_TASK_STATE', '生成结果不属于此任务，未保存。');
        }
        if (record.state === 'committed') return { saved: true, target: prepared.target, alreadySaved: true };
        if (surfaceBusy) throw failure('SHARED_SURFACE_BUSY', '另一个共享任务正在准备或保存，请稍后再试。');
        checkAbort(signal);
        surfaceBusy = true;
        record.committing = true;
        try {
            // Compatibility can change while the independent network task runs.
            // Keep its generated result available instead of silently bypassing
            // newly enabled script/postprocessing requirements during commit.
            const { core, reasons } = await capabilities();
            if (reasons.length) throw failure('SHARED_UNSUPPORTED', `当前配置已不满足共享模式，结果已保留：${reasons.join('；')}`);
            checkAbort(signal);
            if (core.isChatSaving) throw failure('SHARED_NATIVE_BUSY', '主页面正在保存，请稍后重试保存生成结果。');
            const current = getContext();
            let isCurrent = false;
            try {
                const currentTarget = targetOf(current);
                isCurrent = currentTarget.avatar === prepared.target.avatar && currentTarget.chatName === prepared.target.chatName;
            } catch { /* No active character does not change the fixed save target. */ }
            if (!record.finalPayload) {
                const extra = { api: 'openai', model: prepared.model };
                if (result.reasoning) extra.reasoning = result.reasoning;
                const date = new Date(result.finishedAt).toISOString();
                const message = { name: prepared.target.characterName, is_user: false, is_system: false,
                    send_date: date, mes: result.text,
                    gen_started: new Date(result.startedAt).toISOString(), gen_finished: date,
                    extra, swipe_id: 0, swipes: [result.text],
                    swipe_info: [{ send_date: date, gen_started: new Date(result.startedAt).toISOString(), gen_finished: date, extra: clone(extra) }] };
                record.finalPayload = [...clone(record.base), message];
            }
            if (isCurrent && (core.is_send_press || core.streamingProcessor
                || ![canonical(record.base.slice(1)), canonical(record.finalPayload.slice(1))].includes(canonical(clone(current.chat)))
                || canonical(persistedMetadata(current.chatMetadata)) !== canonical(persistedMetadata(record.base[0].chat_metadata)))) {
                throw failure('SHARED_CONFLICT', '目标聊天已有未保存更改或正在生成；结果已保留，未覆盖记录。');
            }
            const latest = await readChat(prepared.target, signal);
            const latestText = canonical(latest);
            // A prior aborted/failed HTTP response may have reached disk already.
            // Verify exact contents before reporting success or retrying a write.
            if (latestText !== canonical(record.finalPayload)) {
                if (fingerprint(latestText) !== record.baseHash || latestText !== record.baseText) {
                    throw failure('SHARED_CONFLICT', '目标聊天已被修改；生成结果已保留，未覆盖记录。');
                }
                const response = await chatRequest('save', prepared.target, { chat: record.finalPayload, force: false }, signal);
                if (response?.ok !== true) throw failure('SHARED_STORAGE_RESPONSE', '保存结果未被宿主确认；请保留生成结果后重试保存。');
            }
            record.state = 'committed';
            return { saved: true, target: prepared.target, alreadySaved: false };
        } finally { record.committing = false; surfaceBusy = false; }
    }

    function release(prepared) {
        const record = records.get(typeof prepared === 'string' ? prepared : prepared?.id);
        if (!record) return false;
        if (record.state === 'running' || record.committing) throw failure('SHARED_TASK_STATE', '运行或保存中的共享任务需要先结束。');
        return records.delete(record.prepared.id);
    }

    return { probe, prepare, execute, commit, release };
}
