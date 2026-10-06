import { extension_settings } from '../../../extensions.js';
import * as extensionRegistry from '../../../extensions.js';
import { installSharedMode } from './shared-mode.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { installScrollQrCompatibility } from './qr-compat.js';
import { installCharacterProfiles } from './character-profiles.js';

const KEY = 'parallel_tavern';
const CONTROLLER = '__PARALLEL_TAVERN_V2__';
const sharedGenerationGuard = (_chat, _size, abort) => {
    if (window.__PT_SHARED_MODE__?.diagnostics().enabled) {
        abort(true);
        window[CONTROLLER]?.notifyShared?.("共享模式已阻止额外原生生成；请使用普通发送，或关闭共享模式后重试。");
    }
};
sharedGenerationGuard.__ptSharedGuard = true;
window.parallelChatSharedGenerationGuard = sharedGenerationGuard;


// Child pages show settings too, but only the main page starts the runtime.
if ((window.__PT_CHILD_ID__ || !window.parent.__PT_CHILD_ID__) && !(window.frameElement?.dataset.ptSessionId && !window.__PT_CHILD_ID__)) {
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
    const persist = child ? bridge.persist : () => {
        saveSettingsDebounced();
        owner.dispatchEvent(new owner.Event('pt-extension-settings'));
    };
    if (typeof settings.showLauncher !== 'boolean') settings.showLauncher = true;
    if (typeof settings.lowGraphicsMode !== 'boolean') settings.lowGraphicsMode = false;
    if (typeof settings.sharedMode !== 'boolean') settings.sharedMode = false;
    if (!child) {
    window.__PT_SETTINGS_BRIDGE__ = { settings, persist };
    window.__PT_EXTENSION_CONFIG__ = settings;
    window.__PT_INSTALL_SCROLL_QR_COMPAT__ = installScrollQrCompatibility;
    window.__PT_INSTALL_CHARACTER_PROFILES__ = (win, options) => installCharacterProfiles(win, { ...options, settings, save: saveSettingsDebounced });
    }

    const sharedInitCleanups = [];
    const root = document.createElement('div');
    root.id = 'pt-extension-settings';
    root.className = 'extension_container';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>并行对话 · 0.5.19</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="pt-extension-show-launcher">
                    <input id="pt-extension-show-launcher" type="checkbox">
                    <span>显示悬浮窗</span>
                </label>
                <small>关闭后隐藏悬浮入口；已打开的会话仍可继续生成。</small>
                <label class="checkbox_label" for="pt-extension-avatar-switch"><input id="pt-extension-avatar-switch" type="checkbox"><span>点击悬浮头像切换对话</span></label>
                <small>默认关闭。开启后点击头像直达对应窗口，点击文字区域仍打开面板。</small>
                <label class="checkbox_label" for="pt-extension-shared-mode"><input id="pt-extension-shared-mode" type="checkbox"><span>共享运行模式（实验，默认关闭）</span></label>
                <small>仅通过兼容检查的纯文本配置可共用一个页面。保留主题；不联动下方低图形设置。Helper/MVU 等尚未适配的配置继续使用完整模式。</small>
                <small id="pt-extension-shared-status" role="status"></small>
                <label class="checkbox_label" for="pt-extension-low-graphics"><input id="pt-extension-low-graphics" type="checkbox"><span>本机低图形负载模式（实验）</span></label>
                <small>关闭酒馆背景图与主要面板装饰，保留同时回复、扩展和角色脚本。立即应用到所有会话；关闭后恢复普通模式外观。需在出现闪退的设备上复测。</small>
                <label class="checkbox_label" for="pt-extension-night"><input id="pt-extension-night" type="checkbox"><span>夜间模式</span></label>
                <label class="checkbox_label" for="pt-extension-character-settings"><input id="pt-extension-character-settings" type="checkbox"><span>按角色记住预设与模型</span></label>
                <small>同一角色的不同聊天共用选择；已有窗口再次切入时恢复，正在生成时不更换。不复制 API 密钥或预设文件。</small>
                <div><button type="button" class="menu_button" id="pt-extension-open">打开并行面板</button></div>
                <small id="pt-extension-status" role="status"></small>
            </div>
        </div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('Extension settings container unavailable');
    container.append(root);
    const checkbox = root.querySelector('input');
    const status = root.querySelector('#pt-extension-status');
    checkbox.checked = settings.showLauncher;
    const avatarSwitch = root.querySelector('#pt-extension-avatar-switch');
    avatarSwitch.checked = settings.avatarQuickSwitch === true;
    avatarSwitch.addEventListener('change', () => { settings.avatarQuickSwitch = avatarSwitch.checked; persist(); });
    const shared = root.querySelector('#pt-extension-shared-mode');
    const sharedStatus = root.querySelector('#pt-extension-shared-status');
    shared.checked = settings.sharedMode === true;
    shared.addEventListener('change', async () => {
        shared.disabled = true;
        try {
            const manager = owner.__PT_SHARED_MODE__;
            const result = manager ? await manager.setEnabled(shared.checked) : { enabled: false, reasons: ['共享运行接口尚未就绪，请稍后重试。'] };
            settings.sharedMode = result.enabled; shared.checked = result.enabled; persist();
            sharedStatus.textContent = result.reasons.length ? '未切换：' + result.reasons.join('；') : result.enabled ? '已开启共享任务；主题保持原样，回复完成后显示。' : '已关闭共享任务，使用原完整模式。';
        } catch {
            settings.sharedMode = owner.__PT_SHARED_MODE__?.diagnostics().enabled === true;
            shared.checked = settings.sharedMode; persist();
            sharedStatus.textContent = '模式切换未完成，请保留当前聊天后重试。';
        } finally { shared.disabled = false; }
    });
    const lowGraphics = root.querySelector('#pt-extension-low-graphics');
    lowGraphics.checked = settings.lowGraphicsMode === true;
    lowGraphics.addEventListener('change', () => {
        settings.lowGraphicsMode = lowGraphics.checked;
        persist();
        owner[CONTROLLER]?.setLowGraphicsMode?.(lowGraphics.checked);
        status.textContent = lowGraphics.checked ? '已降低所有会话的酒馆主题绘图负载，角色脚本和生成继续运行。' : '已恢复普通模式外观。';
    });
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
        lowGraphics.checked = settings.lowGraphicsMode === true;
        shared.checked = settings.sharedMode === true;
        try { night.checked = owner.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch {}
    };
    owner.addEventListener('pt-extension-settings', sync);
    owner.addEventListener('pt-night-mode', sync);
    const disposeSettings = () => {
        sharedInitCleanups.splice(0).forEach(clean => clean());
        owner.removeEventListener('pt-extension-settings', sync);
        owner.removeEventListener('pt-night-mode', sync);
        window.removeEventListener('pagehide', leaving);
    };
    const leaving = event => { if (!event.persisted) disposeSettings(); };
    window.__PT_SETTINGS_DISPOSE__ = disposeSettings;
    window.addEventListener('pagehide', leaving);
    checkbox.addEventListener('change', () => {
        settings.showLauncher = checkbox.checked;
        persist();
        owner[CONTROLLER]?.setLauncherVisible?.(settings.showLauncher);
        status.textContent = settings.showLauncher ? '悬浮窗已显示。' : '悬浮窗已隐藏，可从这里重新打开。';
    });
    root.querySelector('button').addEventListener('click', () => {
        if (owner[CONTROLLER]) owner[CONTROLLER].show();
        else status.textContent = '正在等待酒馆启动，请稍后重试。';
    });
    if (child) return;
    if (window[CONTROLLER] && typeof window[CONTROLLER].setLauncherVisible !== 'function') {
        status.textContent = '检测到酒馆助手旧脚本。请等生成结束后停用旧脚本并刷新，扩展将接管。';
        return;
    }
    await import('./runtime.js');
    window[CONTROLLER]?.setLauncherVisible(settings.showLauncher);
    if (!window[CONTROLLER]?.setSharedView) return;
    const disabledAtLoad = JSON.stringify([...(extension_settings.disabledExtensions || [])].sort());
    const selfExtensionId = decodeURIComponent(new URL('.', import.meta.url).pathname.split('/extensions/').pop().replace(/\/$/, ''));
    const getExtensionState = () => {
        if (!Array.isArray(extensionRegistry.extensionNames) || typeof extensionRegistry.getExtensionManifest !== 'function') return { known: false };
        const manifests = Object.fromEntries(extensionRegistry.extensionNames.map(id => [id, extensionRegistry.getExtensionManifest(id)]));
        const changed = disabledAtLoad !== JSON.stringify([...(extension_settings.disabledExtensions || [])].sort());
        return { known: Object.keys(manifests).length > 0 && Object.values(manifests).every(Boolean), manifests,
            settings: extension_settings, selfExtensionId,
            unsupportedFeatures: changed ? ['扩展启用状态已改变，请刷新酒馆后再检查兼容性'] : [] };
    };
    window.__PT_SHARED_MODE__ = installSharedMode(window, {
        controller: window[CONTROLLER], getExtensionState,
        onModeChange: value => { settings.sharedMode = value; persist(); },
    });
    window[CONTROLLER].registerSharedManager?.(window.__PT_SHARED_MODE__);
    if (settings.sharedMode) {
        const restoreSharedMode = async () => {
            if (!settings.sharedMode || !root.isConnected) return;
            const result = await window.__PT_SHARED_MODE__.setEnabled(true);
            settings.sharedMode = result.enabled; shared.checked = result.enabled;
            if (!result.enabled) { sharedStatus.textContent = '未开启：' + result.reasons.join('；'); persist(); }
        };
        const c = window.SillyTavern.getContext(), event = (c.eventTypes || c.event_types).APP_READY;
        const off = () => c.eventSource.removeListener ? c.eventSource.removeListener(event, ready) : c.eventSource.off(event, ready);
        const ready = () => {
            off();
            const timer = window.setTimeout(() => { void restoreSharedMode().catch(() => { sharedStatus.textContent = '共享模式恢复失败，请手动重试。'; }); }, 0);
            sharedInitCleanups.push(() => window.clearTimeout(timer));
        };
        if (window[CONTROLLER].diagnostics().appReady) ready();
        else { c.eventSource.on(event, ready); sharedInitCleanups.push(off); }
    }
}
