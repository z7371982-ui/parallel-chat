// Character profiles store selections only. Proxy credentials remain native.
const chatControls = {
    makersuite: ['google_model', 'model_google_select'],
    custom: ['custom_model', 'custom_model_id'],
    azure_openai: ['azure_openai_model', 'azure_openai_model'],
};
const textControls = {
    togetherai: 'model_togetherai_select', infermaticai: 'model_infermaticai_select',
    dreamgen: 'model_dreamgen_select',
};
// Sources whose native OpenAI generation path supports reverse proxies.
// Other providers use their own native endpoint/key settings.
const proxySources = new Set(['claude', 'openai', 'mistralai', 'makersuite', 'vertexai', 'deepseek', 'xai', 'zai', 'moonshot']);

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
    const value = { api, source, preset, model: settings[key] };
    if (api === 'openai') value.proxy = { preset: doc.getElementById('openai_proxy_preset')?.value || null };
    return value;
}

export function installCharacterProfiles(win, { settings, save, busy, notify, nativeProxy, initialSelection }) {
    const context = () => win.SillyTavern.getContext();
    const avatar = () => { const c = context(); return !c.groupId && c.characters?.[c.characterId]?.avatar || null; };
    const events = context().eventTypes || context().event_types || {};
    const emitter = context().eventSource;
    const cleanups = [];
    let stopped = false, applying = false, timer, resumeTimer, observed, observedAvatar, queue = Promise.resolve();
    let waitingPreset = false, pendingEdit = false, restoreFailed = false, synchronizingProxy = false;
    let presetProxyName = null;
    let userPresetEdit = false;
    let native, nativeLoaded = !nativeProxy, pendingProxySelection = false, nativeLoadError;
    const nativeReady = Promise.resolve().then(() => nativeProxy?.()).then(module => {
        native = module; nativeLoaded = true;
        if (pendingProxySelection && !stopped) { pendingProxySelection = false; synchronizeProxy(); }
    }).catch(error => { nativeLoadError = error; });
    const enabled = () => settings.rememberCharacterSettings !== false;
    const read = () => selection(context(), win.document);
    const signature = value => JSON.stringify(value);
    const usesProxy = () => context().mainApi === 'openai' && proxySources.has(context().chatCompletionSettings?.chat_completion_source);
    const hasProfile = () => enabled() && Object.hasOwn(settings.characterProfiles || {}, avatar());
    const restorePending = () => hasProfile() && observedAvatar !== avatar();
    const record = () => {
        if (stopped || applying || waitingPreset || !nativeLoaded || restoreFailed || synchronizingProxy) return;
        const id = avatar(), value = read();
        if (!enabled()) { observedAvatar = id; observed = signature(value); pendingEdit = false; return; }
        if (!id || !value || id !== observedAvatar) return;
        // Native settings loading/SETTINGS_UPDATED must never manufacture a
        // role record from a transient startup default.
        if (!pendingEdit) return;
        const next = signature(value);
        if (next === observed && !pendingEdit) return;
        pendingEdit = false;
        observed = next;
        settings.characterProfiles ||= {};
        const previous = { ...(settings.characterProfiles[id] || {}) };
        for (const key of ['key', 'control', 'proxy', 'localProxyPresets', 'localPreset', 'manualProxyOverride']) delete previous[key];
        Object.defineProperty(settings.characterProfiles, id, { value: { ...previous, ...value }, enumerable: true, configurable: true, writable: true });
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
    function resolveProxy(proxy) {
        if (!usesProxy()) return null;
        if (!proxy || typeof proxy.preset !== 'string' || !proxy.preset) throw new Error('角色没有保存代理预设名称，请重新选择代理');
        const stored = native?.proxies?.find(p => p.name === proxy.preset);
        if (!stored || typeof stored.url !== 'string' || typeof stored.password !== 'string') throw new Error('保存的代理预设已不存在或不完整，请重新选择代理');
        return { preset: proxy.preset, url: stored.url, password: stored.password };
    }
    function clearProxy() {
        const wasSynchronizing = synchronizingProxy;
        synchronizingProxy = true;
        try { applyProxyFields({ url: '', password: '' }); } catch {}
        finally {
            // Even a missing/broken host input handler must not leave the prior
            // credential available to the native generation settings.
            const apiSettings = context().chatCompletionSettings;
            if (apiSettings) { apiSettings.reverse_proxy = ''; apiSettings.proxy_password = ''; }
            synchronizingProxy = wasSynchronizing;
        }
    }
    function passwordControl() {
        const selector = native?.settingsToUpdate?.proxy_password?.[0];
        const nativeId = typeof selector === 'string' && /^#[\w-]+$/.test(selector) ? selector.slice(1) : null;
        return [nativeId, 'openai_proxy_password', 'openai_proxy_access_key'].filter(Boolean).find(id => win.document.getElementById(id));
    }
    function applyProxyFields(proxy) {
        const apiSettings = context().chatCompletionSettings;
        const passwordId = passwordControl();
        const urlNode = win.document.getElementById('openai_reverse_proxy');
        if (!passwordId || !urlNode) throw new Error('当前酒馆缺少代理地址或密码控件');
        const nameNode = win.document.getElementById('openai_reverse_proxy_name');
        if (proxy.preset && nameNode) nameNode.value = proxy.preset;
        if (apiSettings.reverse_proxy !== proxy.url || urlNode.value !== proxy.url) setControl(urlNode.id, proxy.url);
        if (apiSettings.proxy_password !== proxy.password || win.document.getElementById(passwordId).value !== proxy.password) setControl(passwordId, proxy.password);
        if (apiSettings.reverse_proxy !== proxy.url || apiSettings.proxy_password !== proxy.password) throw new Error('宿主未接受保存的代理配置');
    }
    function synchronizeProxy(name = win.document.getElementById('openai_proxy_preset')?.value) {
        if (stopped || !enabled() || applying || synchronizingProxy) return;
        if (!nativeLoaded) { pendingProxySelection = true; return; }
        if (!usesProxy()) return;
        synchronizingProxy = true;
        try {
            const proxy = resolveProxy({ preset: name });
            restoreProxy(proxy);
            // Copy both fields before input events can update the role snapshot.
            // Empty passwords are intentional and must clear the previous key.
            restoreFailed = false;
        } catch (error) {
            if (stopped || !enabled()) return;
            restoreFailed = true;
            clearProxy();
            notify(`代理预设未完整切换：${error.message}`);
        } finally { synchronizingProxy = false; }
    }
    function restoreProxy(proxy) {
        if (!proxy) return;
        if (typeof proxy.url !== 'string' || typeof proxy.password !== 'string') throw new Error('保存的代理配置不完整，请重新选择代理');
        const doc = win.document;
        const passwordId = passwordControl();
        const urlNode = doc.getElementById('openai_reverse_proxy');
        if (!passwordId || !urlNode) throw new Error('当前酒馆缺少代理地址或密码控件');
        const preset = doc.getElementById('openai_proxy_preset');
        native.refresh?.(proxy.preset);
        if (proxy.preset && (!preset || ![...preset.options].some(o => o.value === proxy.preset))) {
            throw new Error('保存的代理预设已不存在，请重新选择代理');
        }
        // Always use the current native preset, including an empty password.
        if (proxy.preset && preset.value !== proxy.preset) setControl(preset.id, proxy.preset);
        applyProxyFields(proxy);
        if (proxy.preset && preset.value !== proxy.preset) throw new Error('宿主未接受保存的代理配置');
    }
    async function restore() {
        if (stopped) return;
        const id = avatar();
        if (!id) { observedAvatar = null; return; }
        const hasSaved = enabled() && Object.hasOwn(settings.characterProfiles || {}, id);
        if (!hasSaved) {
            // No role record means use this document's current native settings.
            // Do not inherit another role's snapshot, change fields, or save.
            initialSelection = null;
            observedAvatar = id; observed = signature(read()); pendingEdit = false;
            restoreFailed = false;
            return;
        }
        if (busy()) return;
        const value = settings.characterProfiles[id];
        // Old snapshots contribute their name only; no credentials are copied.
        let completed = false;
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
                if (stopped || !enabled() || avatar() !== id || busy()) return;
                const apiSettings = value.api === 'openai' ? context().chatCompletionSettings : context().textCompletionSettings;
                if (apiSettings[value.api === 'openai' ? 'chat_completion_source' : 'type'] !== value.source) {
                    setControl(value.api === 'openai' ? 'chat_completion_source' : 'textgen_type', value.source);
                }
                // Re-derive the control, rather than trusting a stored selector.
                const current = read();
                if (!current || current.api !== value.api || current.source !== value.source) throw new Error('保存的模型类型当前不受支持');
                if (value.api === 'openai') {
                    // Prompt preset changes can be asynchronous; refresh a named
                    // proxy again in case its saved credentials changed meanwhile.
                    const proxy = resolveProxy(value.proxy);
                    restoreProxy(proxy);
                }
                if (current.model !== value.model) setControl((value.api === 'openai' ? (chatControls[value.source] || [null, `model_${value.source}_select`])[1] : textControls[value.source] || `${value.source}_model`), value.model, true);
                if (read()?.model !== value.model) throw new Error('宿主未接受保存的模型选择');
            }
            restoreFailed = false;
            completed = true;

        } catch (error) {
            if (stopped || !enabled() || avatar() !== id) return;
            restoreFailed = true;
            clearProxy();
            notify(`角色配置未完整恢复：${error.message}`);
        } finally {
            applying = false; waitingPreset = false; pendingEdit = false;
            // A stale restore must not mark the next role as already restored.
            if (!stopped && avatar() === id) {
                observedAvatar = id; observed = signature(read());
                if (completed && enabled() && !restoreFailed) { initialSelection = null; pendingEdit = true; record(); }
            }
        }
    }
    function activate() {
        // Only actual local changes update the shared profile. Viewing an older
        // window must not overwrite a newer selection made in another window.
        record();
        const requestedAvatar = avatar();
        queue = queue.then(async () => {
            if (stopped || avatar() !== requestedAvatar) return;
            if (hasProfile()) {
                await nativeReady;
                if (stopped || avatar() !== requestedAvatar) return;
                if (enabled() && nativeLoadError) throw nativeLoadError;
            }
            return restore();
        }).catch(error => {
            if (stopped || avatar() !== requestedAvatar) return;
            if (!hasProfile()) { restoreFailed = false; observedAvatar = avatar(); observed = signature(read()); return; }
            restoreFailed = true; clearProxy(); notify(`角色配置恢复失败：${error.message}`);
        });
        return queue;
    }
    const changed = (event, data) => {
        const id = event.target?.id || '';
        if (!enabled()) { waitingPreset = false; pendingEdit = false; return; }
        if (synchronizingProxy) return;
        const explicitEdit = event.isTrusted || event.originalEvent?.isTrusted || data?.source === 'user';
        if (id.startsWith('settings_preset_') && explicitEdit) userPresetEdit = true;
        if (id === 'openai_proxy_preset' && !applying && (hasProfile() || explicitEdit)) synchronizeProxy();
        // Only actual BEFORE/AFTER lifecycle events own waitingPreset. A
        // delegated DOM change can arrive after AFTER and must not re-arm it.
        if (/^(main_api|chat_completion_source|textgen_type|settings_preset_|model_|custom_model_id|azure_openai_model|openai_proxy_|openai_reverse_proxy)/.test(id) || id.endsWith('_model')) {
            if (!applying && explicitEdit) pendingEdit = true;
            schedule();
        }
        if (!waitingPreset) Promise.resolve().then(record);
    };
    const guardSend = event => {
        if (event.type === 'click' ? event.target?.closest?.('#send_but') : event.target?.id === 'send_textarea' && event.key === 'Enter' && !event.shiftKey) {
            try { prepareSend(); return; } catch {}
            event.preventDefault(); event.stopImmediatePropagation();
            notify(restoreFailed ? '角色配置恢复失败，请重新选择正确的预设、模型和代理后再发送。' : '正在恢复角色的预设、模型与代理，请稍后发送。');
        }
    };
    win.document.addEventListener('click', guardSend, true);
    win.document.addEventListener('keydown', guardSend, true);
    cleanups.push(() => { win.document.removeEventListener('click', guardSend, true); win.document.removeEventListener('keydown', guardSend, true); });
    if (win.jQuery) {
        // Native addEventListener cannot observe jQuery.trigger used by the host
        // and /proxy commands. One delegated listener handles both event paths.
        win.jQuery(win.document).on('input.ptCharacterProfiles change.ptCharacterProfiles', changed);
        cleanups.push(() => win.jQuery(win.document).off('input.ptCharacterProfiles change.ptCharacterProfiles', changed));
    } else {
        win.document.addEventListener('input', changed);
        win.document.addEventListener('change', changed);
        cleanups.push(() => { win.document.removeEventListener('input', changed); win.document.removeEventListener('change', changed); });
    }
    const proxyButton = event => {
        if (!enabled()) return;
        if (event.target?.closest?.('#save_proxy, #delete_proxy')) {
            // The native buttons update fields with .val(), without input/change.
            Promise.resolve().then(() => {
                if (!stopped && enabled() && !applying) {
                    synchronizeProxy();
                    pendingEdit = true; record(); schedule();
                }
            });
        }
    };
    if (win.jQuery) {
        win.jQuery(win.document).on('click.ptCharacterProfiles', proxyButton);
        cleanups.push(() => win.jQuery(win.document).off('click.ptCharacterProfiles', proxyButton));
    } else {
        win.document.addEventListener('click', proxyButton);
        cleanups.push(() => win.document.removeEventListener('click', proxyButton));
    }
    on(events.OAI_PRESET_CHANGED_BEFORE, () => {
        if (!enabled()) return;
        waitingPreset = true;
        if (!applying) { presetProxyName = win.document.getElementById('openai_proxy_preset')?.value || null; }
    });
    on(events.OAI_PRESET_CHANGED_AFTER, () => {
        waitingPreset = false;
        if (!enabled()) { presetProxyName = null; userPresetEdit = false; return; }
        const name = presetProxyName || read()?.proxy?.preset;
        if (!applying && (hasProfile() || userPresetEdit)) { synchronizeProxy(name); userPresetEdit = false; }
        else if (!applying) {
            // A synchronous native AFTER may precede the trusted DOM change.
            Promise.resolve().then(() => { if (!stopped && enabled() && !applying && userPresetEdit) synchronizeProxy(name); userPresetEdit = false; });
        }
        if (hasProfile()) userPresetEdit = false;
        presetProxyName = null;
        schedule();
    });
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
    function prepareSend({ stage = 'ui' } = {}) {
        if (!enabled()) return read();
        if (applying || waitingPreset || restorePending()) throw new Error('角色配置尚未准备完成');
        if (restoreFailed) throw new Error('角色配置恢复失败，请重新选择正确设置');
        if (!hasProfile()) return read();
        if (!nativeLoaded) throw new Error('角色配置尚未准备完成');
        if (stage === 'request') {
            // The native request body already exists. Never change its context
            // or UI here; synchronization belongs before native generation.
            resolveProxy(read()?.proxy);
        } else synchronizeProxy();
        if (restoreFailed) throw new Error('代理预设不可用，请重新选择酒馆已保存的预设');
        return read();
    }
    return {
        ready: activate(), activate, flush: record,
        prepareSend,
        adoptCurrent() {
            if (stopped || !enabled()) throw new Error('请先开启按角色记住设置');
            if (applying || waitingPreset || busy()) throw new Error('请等待设置加载、生成和保存结束');
            const id = avatar(), value = read();
            if (!id || !value) throw new Error('当前没有可记录的单角色预设和模型');
            if (!nativeLoaded) throw new Error('原生配置列表尚未连接，请稍后再试');
            if (usesProxy()) resolveProxy(value.proxy);
            // This explicit user action stores references only, never credentials.
            observedAvatar = id; observed = undefined; pendingEdit = true; restoreFailed = false;
            record();
            return value;
        },
        get blocked() { return enabled() && (applying || waitingPreset || restoreFailed || restorePending() || hasProfile() && !nativeLoaded); },
        capture() {
            if (enabled() && (hasProfile() && !nativeLoaded || applying || waitingPreset || synchronizingProxy || restoreFailed)) throw new Error('当前预设正在切换或尚未恢复，请稍后再打开角色');
            const value = read();
            return value ? { ...value, ...(value.proxy ? { proxy: { ...value.proxy } } : {}) } : null;
        },
        dispose() { record(); stopped = true; win.clearTimeout(timer); win.clearTimeout(resumeTimer); cleanups.forEach(fn => fn()); },
    };
}
