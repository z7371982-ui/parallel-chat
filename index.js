import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { installScrollQrCompatibility } from './qr-compat.js';

const KEY = 'parallel_tavern';
const CONTROLLER = '__PARALLEL_TAVERN_V2__';

// Each parallel child loads the native extension list too. Only the main
// document owns the settings panel and controller.
if (!window.__PT_CHILD_ID__ && !window.parent.__PT_CHILD_ID__) {
    void initialize().catch(error => {
        console.error('[Parallel Tavern extension]', error);
        const status = document.getElementById('pt-extension-status');
        if (status) status.textContent = '启动失败，请查看控制台或刷新后重试。';
    });
}

async function initialize() {
    if (document.getElementById('pt-extension-settings')) return;
    const settings = extension_settings[KEY] ||= {};
    if (typeof settings.showLauncher !== 'boolean') settings.showLauncher = true;
    window.__PT_EXTENSION_CONFIG__ = settings;
    window.__PT_INSTALL_SCROLL_QR_COMPAT__ = installScrollQrCompatibility;

    const root = document.createElement('div');
    root.id = 'pt-extension-settings';
    root.className = 'extension_container';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>并行对话 · 0.4.3</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="pt-extension-show-launcher">
                    <input id="pt-extension-show-launcher" type="checkbox">
                    <span>显示悬浮窗</span>
                </label>
                <small>关闭后隐藏悬浮入口；已打开的会话仍可继续生成。</small>
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
    checkbox.addEventListener('change', () => {
        settings.showLauncher = checkbox.checked;
        saveSettingsDebounced();
        window[CONTROLLER]?.setLauncherVisible?.(settings.showLauncher);
        status.textContent = settings.showLauncher ? '悬浮窗已显示。' : '悬浮窗已隐藏，可从这里重新打开。';
    });
    root.querySelector('button').addEventListener('click', () => {
        if (window[CONTROLLER]) window[CONTROLLER].show();
        else status.textContent = '正在等待酒馆启动，请稍后重试。';
    });
    if (window[CONTROLLER] && typeof window[CONTROLLER].setLauncherVisible !== 'function') {
        status.textContent = '检测到酒馆助手旧脚本。请等生成结束后停用旧脚本并刷新，扩展将接管。';
        return;
    }
    await import('./runtime.js');
    window[CONTROLLER]?.setLauncherVisible(settings.showLauncher);
}
