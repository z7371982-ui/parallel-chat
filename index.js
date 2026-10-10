import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import * as core from '../../../../script.js';
import { installScrollQrCompatibility } from './qr-compat.js';
import { installCharacterProfiles } from './character-profiles.js';
import * as nativeOpenAI from '../../../openai.js';

const KEY = 'parallel_tavern';
const CONTROLLER = '__PARALLEL_TAVERN_V2__';
const nativeProxyModules = new WeakMap();
const profileInstances = new WeakMap();
const VERSION = '0.7.0-unified-r3';

function chooseRuntimeMode(settings) {
    if (['multi-window', 'low-memory'].includes(settings.runtimeMode)) return settings.runtimeMode;
    if (['parallelEnabled', 'backgroundWrite', 'backgroundProgress'].some(key => Object.hasOwn(settings, key))) return 'low-memory';
    return Object.keys(settings).length ? 'multi-window' : 'low-memory';
}

function getNativeProxySettings(win) {
    if (win === window) return Promise.resolve(nativeOpenAI);
    if (!nativeProxyModules.has(win)) {
        nativeProxyModules.set(win, new Promise((resolve, reject) => {
            // Import in the child document: every conversation owns its native
            // settings and proxy list. A parent import would mix credentials.
            const script = win.document.createElement('script');
            script.type = 'module';
            const cleanup = () => {
                win.clearTimeout(timeout);
                win.removeEventListener('pt-native-proxy-ready', ready);
                script.remove();
            };
            const ready = () => {
                cleanup();
                const childProxy = win.__PT_NATIVE_PROXY__;
                resolve({
                    // ES module exports stay live; never cache a credential table.
                    get proxies() { return nativeOpenAI.proxies; },
                    get settingsToUpdate() { return childProxy.settingsToUpdate; },
                    refresh(name) {
                        const selected = nativeOpenAI.proxies?.find(proxy => proxy.name === name);
                        if (!selected || typeof selected.url !== 'string' || typeof selected.password !== 'string') throw new Error('原生代理预设已不存在或不完整');
                        if (typeof childProxy.loadProxyPresets !== 'function') throw new Error('宿主不支持刷新原生代理列表');
                        // loadProxyPresets mutates its selected entry: clone both
                        // the list and the authoritative selected value.
                        childProxy.loadProxyPresets({ proxies: nativeOpenAI.proxies.map(proxy => ({ ...proxy })), selected_proxy: { ...selected } });
                    },
                });
            };
            const timeout = win.setTimeout(() => { cleanup(); reject(new Error('读取原生代理预设超时')); }, 10000);
            win.addEventListener('pt-native-proxy-ready', ready, { once: true });
            script.onerror = () => { cleanup(); reject(new Error('无法读取原生代理预设')); };
            script.textContent = `import * as proxy from ${JSON.stringify(new URL('scripts/openai.js', window.location.href).href)}; window.__PT_NATIVE_PROXY__ = proxy; window.dispatchEvent(new window.Event('pt-native-proxy-ready'));`;
            win.document.head.append(script);
        }));
    }
    return nativeProxyModules.get(win);
}

// Child pages show settings too, but only the main page starts the runtime.
if (window.__PT_CHILD_ID__ || !window.parent.__PT_CHILD_ID__) {
    void initialize().catch(error => {
        console.error('[Parallel Tavern extension]', error);
        const status = document.getElementById('pt-extension-status');
        if (status) status.textContent = '启动失败，请查看控制台或刷新后重试。';
    });
}

async function initialize() {
    if (document.getElementById('pt-extension-settings')) return;
    const child = !!window.__PT_CHILD_ID__;
    const owner = child ? window.parent : window;
    const bridge = child ? owner.__PT_SETTINGS_BRIDGE__ : null;
    if (child && !bridge) throw new Error('主页面设置接口尚未就绪，请刷新后重试。');
    const settings = child ? bridge.settings : (extension_settings[KEY] ||= {});
    const runningMode = child ? 'multi-window' : chooseRuntimeMode(settings);
    if (!child) settings.runtimeMode = runningMode;
    const persist = child ? bridge.persist : () => {
        saveSettingsDebounced();
        owner.dispatchEvent(new owner.Event('pt-extension-settings'));
    };
    if (typeof settings.showLauncher !== 'boolean') settings.showLauncher = true;
    if (!child) {
    window.__PT_SETTINGS_BRIDGE__ = { settings, persist };
    window.__PT_EXTENSION_CONFIG__ = settings;
    window.__PT_INSTALL_SCROLL_QR_COMPAT__ = installScrollQrCompatibility;
    window.__PT_INSTALL_CHARACTER_PROFILES__ = (win, options) => {
        const profile = installCharacterProfiles(win, { ...options, settings, save: saveSettingsDebounced, nativeProxy: () => getNativeProxySettings(win) });
        profileInstances.set(win, profile);
        return profile;
    };
    }

    const root = document.createElement('div');
    root.id = 'pt-extension-settings';
    root.className = 'extension_container';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>并行对话 · ${VERSION}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label for="pt-extension-mode">运行模式</label>
                <select id="pt-extension-mode" class="text_pole"><option value="low-memory">低内存 · 单页面</option><option value="multi-window">多窗口 · 独立页面</option></select>
                <small>选择后下次刷新生效。低内存适合苹果及内存有限设备；多窗口保留独立页面。切换选择不会中断当前任务。</small>
                <button type="button" class="menu_button" id="pt-extension-reload">安全刷新应用模式</button>
                ${runningMode === 'low-memory' ? '<label class="checkbox_label" for="pt-extension-enabled"><input id="pt-extension-enabled" type="checkbox"><span>开启角色并行</span></label><label class="checkbox_label" for="pt-extension-background-write"><input id="pt-extension-background-write" type="checkbox"><span>后台回复直接存入聊天</span></label><label class="checkbox_label" for="pt-extension-background-progress"><input id="pt-extension-background-progress" type="checkbox"><span>生成途中定时保存进度</span></label><small>进度保存默认关闭；长聊天会增加写入开销。宿主不支持后台写入时，切回会话再处理回复。</small>' : ''}
                <label class="checkbox_label" for="pt-extension-show-launcher">
                    <input id="pt-extension-show-launcher" type="checkbox">
                    <span>显示悬浮窗</span>
                </label>
                <small>拖到左边向左滑、右边向右滑，可收为侧边条，点击展开。黄色：生成中；绿色：有完成回复待查看。关闭入口后会话仍可继续生成。</small>
                <label class="checkbox_label" for="pt-extension-avatar-switch"><input id="pt-extension-avatar-switch" type="checkbox"><span>点击悬浮头像切换对话</span></label>
                <small>默认关闭。开启后点击头像直达对应窗口，点击文字区域仍打开面板。</small>
                <label class="checkbox_label" for="pt-extension-night"><input id="pt-extension-night" type="checkbox"><span>夜间模式</span></label>
                <label class="checkbox_label" for="pt-extension-character-settings"><input id="pt-extension-character-settings" type="checkbox"><span>按角色记住预设、模型与代理</span></label>
                <small>只记住角色的预设、代理预设名称和模型；代理网站与密钥始终读取当前酒馆原生预设。请在主页面保存代理配置。同一角色的不同聊天共用选择，正在生成或保存时不更换。</small>
                <button type="button" class="menu_button" id="pt-extension-adopt-profile">以当前选择更新本角色</button>
                <small>无角色记录时保留现场设置。此按钮只在你明确点击后记录当前窗口的预设、模型和代理名称，可修正旧记录。</small>
                <div><button type="button" class="menu_button" id="pt-extension-open">打开并行面板</button></div>
                <small id="pt-extension-status" role="status"></small>
            </div>
        </div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('Extension settings container unavailable');
    container.append(root);
    const checkbox = root.querySelector('#pt-extension-show-launcher');
    const status = root.querySelector('[role="status"]');
    root.querySelector('#pt-extension-adopt-profile').addEventListener('click', () => {
        const active = owner[CONTROLLER]?.getActiveWindow?.() || owner;
        try {
            const profile = profileInstances.get(active);
            if (!profile) throw new Error('当前窗口的角色设置尚未连接，请稍后再试');
            profile.adoptCurrent();
            status.textContent = '当前角色的选择已更新；只保存预设、模型和代理名称。';
        } catch (error) { status.textContent = String(error.message || '角色选择未保存'); }
    });
    const mode = root.querySelector('#pt-extension-mode');
    mode.value = settings.runtimeMode;
    mode.disabled = child;
    mode.addEventListener('change', () => {
        settings.runtimeMode = mode.value;
        persist();
        status.textContent = '模式选择已保存。当前模式继续运行，空闲且无草稿时可刷新生效。';
    });
    const reload = root.querySelector('#pt-extension-reload');
    reload.disabled = child;
    reload.addEventListener('click', async () => {
        const controller = owner[CONTROLLER];
        if (!controller?.canReload?.()) {
            status.textContent = '请等待生成、保存和后台回复处理结束，并先发送或另存所有窗口的输入草稿，再刷新。';
            return;
        }
        persist();
        // Debounced persistence must finish before leaving the document.
        try {
            const context = owner.SillyTavern.getContext();
            const updated = (context.eventTypes || context.event_types)?.SETTINGS_UPDATED;
            if (typeof core.saveSettings !== 'function' || !updated || !context.eventSource?.on) {
                status.textContent = '模式已保存。宿主不支持等待保存完成，请稍后手动刷新。'; return;
            }
            await new Promise((resolve, reject) => {
                const remove = () => context.eventSource.removeListener ? context.eventSource.removeListener(updated, done) : context.eventSource.off?.(updated, done);
                const done = () => { owner.clearTimeout(timeout); remove(); resolve(); };
                const timeout = owner.setTimeout(() => { remove(); reject(new Error('保存未确认')); }, 10000);
                context.eventSource.on(updated, done);
                Promise.resolve(core.saveSettings()).catch(error => { owner.clearTimeout(timeout); remove(); reject(error); });
            });
            if (!controller.canReload()) { status.textContent = '当前有新任务或草稿，请处理后再刷新。'; return; }
            owner.location.reload();
        } catch { status.textContent = '设置保存失败，请稍后再试。'; }
    });
    const enabledBox = root.querySelector('#pt-extension-enabled');
    if (enabledBox) {
        enabledBox.checked = settings.parallelEnabled === true;
        enabledBox.addEventListener('change', () => {
            owner[CONTROLLER]?.setEnabled?.(enabledBox.checked);
            enabledBox.checked = settings.parallelEnabled === true;
        });
    }
    for (const [id, key, fallback] of [['pt-extension-background-write', 'backgroundWrite', true], ['pt-extension-background-progress', 'backgroundProgress', false]]) {
        const input = root.querySelector(`#${id}`);
        if (!input) continue;
        input.checked = typeof settings[key] === 'boolean' ? settings[key] : fallback;
        input.addEventListener('change', () => { settings[key] = input.checked; persist(); });
    }
    checkbox.checked = settings.showLauncher;
    const avatarSwitch = root.querySelector('#pt-extension-avatar-switch');
    avatarSwitch.checked = settings.avatarQuickSwitch === true;
    avatarSwitch.addEventListener('change', () => { settings.avatarQuickSwitch = avatarSwitch.checked; persist(); });
    const night = root.querySelector('#pt-extension-night');
    const remember = root.querySelector('#pt-extension-character-settings');
    remember.checked = settings.rememberCharacterSettings !== false;
    remember.addEventListener('change', () => { settings.rememberCharacterSettings = remember.checked; persist(); });
    try { night.checked = owner.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch {}
    night.addEventListener('change', () => {
        try { owner.localStorage.setItem('parallel-tavern.night-mode', night.checked ? 'on' : 'off'); } catch {}
        owner[CONTROLLER]?.setNightMode?.(night.checked);
    });
    const sync = () => {
        checkbox.checked = settings.showLauncher !== false;
        avatarSwitch.checked = settings.avatarQuickSwitch === true;
        remember.checked = settings.rememberCharacterSettings !== false;
        mode.value = settings.runtimeMode;
        if (enabledBox) enabledBox.checked = settings.parallelEnabled === true;
        try { night.checked = owner.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch {}
    };
    owner.addEventListener('pt-extension-settings', sync);
    owner.addEventListener('pt-night-mode', sync);
    owner.addEventListener('pt-parallel-enabled', sync);
    const disposeSettings = () => {
        owner.removeEventListener('pt-extension-settings', sync);
        owner.removeEventListener('pt-night-mode', sync);
        owner.removeEventListener('pt-parallel-enabled', sync);
    };
    window.__PT_SETTINGS_DISPOSE__ = disposeSettings;
    window.addEventListener('pagehide', disposeSettings, { once: true });
    checkbox.addEventListener('change', () => {
        settings.showLauncher = checkbox.checked;
        persist();
        owner[CONTROLLER]?.setLauncherVisible?.(settings.showLauncher);
        status.textContent = settings.showLauncher ? '悬浮窗已显示。' : '悬浮窗已隐藏，可从这里重新打开。';
    });
    root.querySelector('#pt-extension-open').addEventListener('click', () => {
        if (owner[CONTROLLER]) owner[CONTROLLER].show();
        else status.textContent = '正在等待酒馆启动，请稍后重试。';
    });
    if (child) return;
    if (window[CONTROLLER] && typeof window[CONTROLLER].setLauncherVisible !== 'function') {
        status.textContent = '检测到酒馆助手旧脚本。请等生成结束后停用旧脚本并刷新，扩展将接管。';
        return;
    }
    window.__PT_CORE__ = core;
    if (runningMode === 'low-memory') {
        const style = document.createElement('link'); style.rel = 'stylesheet';
        style.href = new URL('./low-memory.css', import.meta.url).href;
        document.head.append(style);
        let regexEngine = null;
        try { regexEngine = await import('../../regex/engine.js'); } catch {}
        const { start } = await import('./runtime-low-memory.js');
        start({ settings, save: saveSettingsDebounced, nativeBusy: () => core.is_send_press, nativeSaving: () => core.isChatSaving,
            nativeCore: core, regexEngine, installProfiles: (win, options) => window.__PT_INSTALL_CHARACTER_PROFILES__(win, options) });
    } else await import('./runtime.js');
    window[CONTROLLER]?.setLauncherVisible(settings.showLauncher);
}
