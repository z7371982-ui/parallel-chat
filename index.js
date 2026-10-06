import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { installScrollQrCompatibility } from './qr-compat.js';
import { installCharacterProfiles } from './character-profiles.js';

const KEY = 'parallel_tavern';
const CONTROLLER = '__PARALLEL_TAVERN_V2__';

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
    if (!child) {
    window.__PT_SETTINGS_BRIDGE__ = { settings, persist };
    window.__PT_EXTENSION_CONFIG__ = settings;
    window.__PT_INSTALL_SCROLL_QR_COMPAT__ = installScrollQrCompatibility;
    window.__PT_INSTALL_CHARACTER_PROFILES__ = (win, options) => installCharacterProfiles(win, { ...options, settings, save: saveSettingsDebounced });
    }

    const root = document.createElement('div');
    root.id = 'pt-extension-settings';
    root.className = 'extension_container';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>并行对话 · 0.5.17</b>
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
    const status = root.querySelector('[role="status"]');
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
        try { night.checked = owner.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch {}
    };
    owner.addEventListener('pt-extension-settings', sync);
    owner.addEventListener('pt-night-mode', sync);
    const disposeSettings = () => {
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
}
