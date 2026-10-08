// Proxy credentials are explicitly remembered per character in host extension
// settings. Provider secrets and complete prompt/connection presets are not copied.
const chatControls = {
    makersuite: ['google_model', 'model_google_select'],
    custom: ['custom_model', 'custom_model_id'],
    azure_openai: ['azure_openai_model', 'azure_openai_model'],
};
const textControls = {
    togetherai: 'model_togetherai_select', infermaticai: 'model_infermaticai_select',
    dreamgen: 'model_dreamgen_select',
};

function selection(context, doc) {
    const api = context.mainApi;
    if (!['openai', 'textgenerationwebui'].includes(api)) return null;
    const settings = api === 'openai' ? context.chatCompletionSettings : context.textCompletionSettings;
    const source = settings?.[api === 'openai' ? 'chat_completion_source' : 'type'];
    const preset = context.getPresetManager?.(api)?.getSelectedPresetName?.();
    if (!source || !preset) return null;
    const [key, id] = api === 'openai'
        ? (chatControls[source] || [`${source}_model`, `model_${source}_select`])
        : [`${source}_model`, textControls[source] || `${source}_model`];
    // Unknown/custom hosts retain their normal behavior instead of guessing a control.
    if (!doc.getElementById(id) || typeof settings[key] !== 'string') return null;
    const value = { api, source, preset, model: settings[key], key, control: id };
    if (api === 'openai' && typeof settings.reverse_proxy === 'string' && typeof settings.proxy_password === 'string') {
        value.proxy = {
            preset: doc.getElementById('openai_proxy_preset')?.value || null,
            url: settings.reverse_proxy, password: settings.proxy_password,
        };
    }
    return value;
}

export function installCharacterProfiles(win, { settings, save, busy, notify }) {
    const context = () => win.SillyTavern.getContext();
    const avatar = () => { const c = context(); return !c.groupId && c.characters?.[c.characterId]?.avatar || null; };
    const events = context().eventTypes || context().event_types || {};
    const emitter = context().eventSource;
    const cleanups = [];
    let stopped = false, applying = false, timer, resumeTimer, observed, observedAvatar, queue = Promise.resolve();
    let waitingPreset = false, pendingEdit = false, restoreFailed = false;
    const legacyNotices = new Set();
    const enabled = () => settings.rememberCharacterSettings !== false;
    const read = () => selection(context(), win.document);
    const signature = value => JSON.stringify(value);
    const record = () => {
        if (stopped || applying || waitingPreset) return;
        const id = avatar(), value = read();
        if (!enabled()) { observedAvatar = id; observed = signature(value); pendingEdit = false; return; }
        if (!id || !value || id !== observedAvatar) return;
        const next = signature(value);
        if (next === observed && !pendingEdit) return;
        pendingEdit = false;
        observed = next;
        settings.characterProfiles ||= {};
        Object.defineProperty(settings.characterProfiles, id, { value, enumerable: true, configurable: true, writable: true });
        save();
    };
    const schedule = () => { win.clearTimeout(timer); timer = win.setTimeout(record, 200); };
    function on(name, fn) {
        if (!name || !emitter?.on) return;
        emitter.on(name, fn);
        cleanups.push(() => emitter.removeListener ? emitter.removeListener(name, fn) : emitter.off?.(name, fn));
    }
    function setControl(id, value, allowModel = false) {
        const node = win.document.getElementById(id);
        if (!node) throw new Error('当前酒馆缺少对应设置控件');
        if (node.tagName === 'SELECT' && ![...node.options].some(o => o.value === value)) {
            if (!allowModel) throw new Error('保存的接口类型当前不可用');
            // Native model controls accept explicit model IDs, including custom endpoints.
            const option = win.document.createElement('option'); option.value = value; option.textContent = value; node.append(option);
        }
        if (win.jQuery) win.jQuery(node).val(value).trigger(node.tagName === 'SELECT' ? 'change' : 'input');
        else { node.value = value; node.dispatchEvent(new win.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
    }
    const sameSelection = (saved, current) => !!current &&
        ['api', 'source', 'preset', 'model'].every(key => saved[key] === current[key]) &&
        (!saved.proxy || !!current.proxy && ['preset', 'url', 'password'].every(key => saved.proxy[key] === current.proxy[key]));
    function restoreProxy(proxy) {
        if (!proxy) return;
        if (typeof proxy.url !== 'string' || typeof proxy.password !== 'string') throw new Error('保存的代理配置不完整，请重新选择代理');
        const doc = win.document;
        const passwordId = ['openai_proxy_password', 'openai_proxy_access_key'].find(id => doc.getElementById(id));
        const urlNode = doc.getElementById('openai_reverse_proxy');
        if (!passwordId || !urlNode) throw new Error('当前酒馆缺少代理地址或密码控件');
        const preset = doc.getElementById('openai_proxy_preset');
        if (proxy.preset && (!preset || ![...preset.options].some(o => o.value === proxy.preset))) {
            throw new Error('保存的代理预设已不存在，请重新选择代理');
        }
        // Native preset change restores its own address/password. Then restore the
        // character snapshot, including an explicitly empty password, in this realm.
        if (proxy.preset && preset.value !== proxy.preset) setControl(preset.id, proxy.preset);
        const apiSettings = context().chatCompletionSettings;
        if (apiSettings.reverse_proxy !== proxy.url) setControl(urlNode.id, proxy.url);
        if (apiSettings.proxy_password !== proxy.password) setControl(passwordId, proxy.password);
        if (apiSettings.reverse_proxy !== proxy.url || apiSettings.proxy_password !== proxy.password ||
            proxy.preset && preset.value !== proxy.preset) throw new Error('宿主未接受保存的代理配置');
    }
    async function restore() {
        if (stopped || !enabled() || busy()) return;
        const id = avatar();
        if (!id) { observedAvatar = null; return; }
        const value = Object.hasOwn(settings.characterProfiles || {}, id) ? settings.characterProfiles[id] : null;
        const existing = read();
        if (value && sameSelection(value, existing)) {
            observedAvatar = id; observed = signature(existing); pendingEdit = false;
            restoreFailed = false;
            warnLegacy(value, id);
            return;
        }
        applying = true;
        try {
            if (value && ['openai', 'textgenerationwebui'].includes(value.api)) {
                const manager = context().getPresetManager?.(value.api);
                const presetId = manager?.findPreset?.(value.preset);
                if (presetId == null) throw new Error(`预设「${value.preset}」已不存在，请重新选择`);
                if (context().mainApi !== value.api) setControl('main_api', value.api);
                if (manager.getSelectedPresetName() !== value.preset) {
                    await new Promise((resolve, reject) => {
                        const event = value.api === 'openai' ? events.OAI_PRESET_CHANGED_AFTER : events.PRESET_CHANGED;
                        if (!event) { reject(new Error('宿主不支持等待预设切换完成')); return; }
                        const remove = () => emitter.removeListener ? emitter.removeListener(event, done) : emitter.off?.(event, done);
                        const timeout = win.setTimeout(() => { remove(); reject(new Error('预设切换超时')); }, 10000);
                        const done = data => {
                            if (value.api !== 'openai' && data?.apiId && data.apiId !== value.api) return;
                            if (manager.getSelectedPresetName() !== value.preset) return;
                            win.clearTimeout(timeout); remove(); resolve();
                        };
                        emitter.on(event, done);
                        try { manager.selectPreset(presetId); }
                        catch (error) { win.clearTimeout(timeout); remove(); reject(error); }
                    });
                }
                if (stopped || avatar() !== id || busy()) return;
                const apiSettings = value.api === 'openai' ? context().chatCompletionSettings : context().textCompletionSettings;
                if (apiSettings[value.api === 'openai' ? 'chat_completion_source' : 'type'] !== value.source) {
                    setControl(value.api === 'openai' ? 'chat_completion_source' : 'textgen_type', value.source);
                }
                // Re-derive the control, rather than trusting a stored selector.
                const current = read();
                if (!current || current.api !== value.api || current.source !== value.source) throw new Error('保存的模型类型当前不受支持');
                if (value.api === 'openai') restoreProxy(value.proxy);
                if (current.model !== value.model) setControl(current.control, value.model, true);
                if (read()?.model !== value.model) throw new Error('宿主未接受保存的模型选择');
            }
            restoreFailed = false;
            warnLegacy(value, id);
        } catch (error) {
            restoreFailed = true;
            notify(`角色配置未完整恢复：${error.message}`);
        } finally {
            observedAvatar = avatar(); observed = signature(read()); applying = false; pendingEdit = false;
            if (!value && observedAvatar === id) { observed = undefined; record(); }
        }
    }
    function warnLegacy(value, id) {
        if (value?.api === 'openai' && !value.proxy && read()?.proxy && !legacyNotices.has(id)) {
            legacyNotices.add(id);
            notify('这个角色的旧记录没有代理信息，请重新选择一次正确的代理预设和密码，以后会一起记住。');
        }
    }
    function activate() {
        // Only actual local changes update the shared profile. Viewing an older
        // window must not overwrite a newer selection made in another window.
        record();
        queue = queue.then(restore).catch(error => notify(`角色配置恢复失败：${error.message}`));
        return queue;
    }
    const changed = event => {
        const id = event.target?.id || '';
        if (id.startsWith('settings_preset_')) waitingPreset = true;
        if (/^(main_api|chat_completion_source|textgen_type|settings_preset_|model_|custom_model_id|azure_openai_model|openai_proxy_|openai_reverse_proxy)/.test(id) || id.endsWith('_model')) {
            if (!applying) { pendingEdit = true; restoreFailed = false; }
            schedule();
        }
        if (!waitingPreset) Promise.resolve().then(record);
    };
    const guardSend = event => {
        if ((!applying && !restoreFailed) || !enabled()) return;
        if (event.type === 'click' ? event.target?.closest?.('#send_but') : event.target?.id === 'send_textarea' && event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); event.stopImmediatePropagation();
            notify(restoreFailed ? '角色配置恢复失败，请重新选择正确的预设、模型和代理后再发送。' : '正在恢复角色的预设、模型与代理，请稍后发送。');
        }
    };
    win.document.addEventListener('click', guardSend, true);
    win.document.addEventListener('keydown', guardSend, true);
    cleanups.push(() => { win.document.removeEventListener('click', guardSend, true); win.document.removeEventListener('keydown', guardSend, true); });
    win.document.addEventListener('input', changed);
    win.document.addEventListener('change', changed);
    cleanups.push(() => { win.document.removeEventListener('input', changed); win.document.removeEventListener('change', changed); });
    on(events.OAI_PRESET_CHANGED_BEFORE, () => { waitingPreset = true; if (!applying) pendingEdit = true; });
    on(events.OAI_PRESET_CHANGED_AFTER, () => { waitingPreset = false; schedule(); });
    on(events.PRESET_CHANGED, () => { waitingPreset = false; schedule(); });
    on(events.SETTINGS_UPDATED, schedule);
    on(events.CHATCOMPLETION_MODEL_CHANGED, schedule);
    on(events.CHAT_CHANGED, activate);
    on(events.GENERATION_ENDED, () => {
        // Session/native busy flags are updated by other listeners in the same
        // event dispatch. Restore only after those listeners have finished.
        win.clearTimeout(resumeTimer);
        resumeTimer = win.setTimeout(() => { void activate(); }, 0);
    });
    on(events.APP_READY, activate);
    return {
        ready: activate(), activate, flush: record,
        dispose() { record(); stopped = true; win.clearTimeout(timer); win.clearTimeout(resumeTimer); cleanups.forEach(fn => fn()); },
    };
}
