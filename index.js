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
                <b>并行对话 · 0.5.20</b>
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
                <div id="pt-extension-shared-status" role="status" aria-live="polite" style="display:block;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0"></div>
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
    function showSharedFailure(title, message) {
        const doc = owner.document;
        doc.getElementById('pt-shared-mode-failure')?.remove();
        const dialog = doc.createElement('dialog');
        dialog.id = 'pt-shared-mode-failure';
        dialog.setAttribute('aria-labelledby', 'pt-shared-mode-failure-title');
        dialog.style.cssText = 'box-sizing:border-box;max-width:calc(100vw - 24px);width:560px;max-height:85vh;overflow:auto;padding:20px;border:1px solid currentColor;border-radius:10px;background:Canvas;color:CanvasText;';
        const heading = doc.createElement('h3');
        heading.id = 'pt-shared-mode-failure-title'; heading.textContent = title;
        const description = doc.createElement('p');
        description.textContent = '下面是本次检查的具体原因，可以复制后反馈。';
        const details = doc.createElement('textarea');
        details.id = 'pt-shared-mode-failure-text'; details.readOnly = true;
        details.setAttribute('aria-label', '共享模式检查原因');
        details.rows = Math.min(12, Math.max(5, message.split('\n').length + 2));
        details.value = '并行对话 0.5.20\n' + message;
        details.style.cssText = 'box-sizing:border-box;width:100%;white-space:pre-wrap;resize:vertical;background:Canvas;color:CanvasText;';
        const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'menu_button'; copy.textContent = '复制原因';
        copy.addEventListener('click', async () => {
            try { await owner.navigator.clipboard.writeText(details.value); copy.textContent = '已复制'; }
            catch { details.focus(); details.select(); copy.textContent = '请长按选中的文字复制'; }
        });
        const close = doc.createElement('button'); close.type = 'button'; close.className = 'menu_button'; close.textContent = '关闭';
        close.addEventListener('click', () => dialog.remove());
        dialog.addEventListener('cancel', () => dialog.remove());
        dialog.append(heading, description, details, copy, close); doc.body.append(dialog);
        try { dialog.showModal(); }
        catch { dialog.setAttribute('open', ''); dialog.style.cssText += 'position:fixed;inset:12px 0 auto;z-index:2147483647;'; }
        dialog.style.setProperty('display', 'block', 'important');
        close.focus();
    }
    sharedInitCleanups.push(() => owner.document.getElementById('pt-shared-mode-failure')?.remove());
    function persistSharedSelection() {
        try { persist(); return ''; }
        catch { return '设置保存失败：当前运行状态已保留，但刷新后可能恢复旧设置。请确认酒馆能正常保存设置后重试。'; }
    }
    function showSharedResult(result, { requested, interactive = false } = {}) {
        settings.sharedMode = result.enabled === true; shared.checked = settings.sharedMode;
        const reasons = result.reasons || [];
        const message = reasons.length ? '未切换：\n' + reasons.map(reason => '• ' + reason).join('\n')
            : result.enabled ? '已开启共享任务；主题保持原样，回复完成后显示。' : '已关闭共享任务，使用原完整模式。';
        // Report before persistence: a settings-save failure must never erase the
        // compatibility reason or make the catch path attempt the same save again.
        sharedStatus.textContent = message;
        const saveFailure = persistSharedSelection();
        if (saveFailure) sharedStatus.textContent += '\n' + saveFailure;
        if (interactive && (reasons.length || saveFailure)) {
            const title = reasons.length ? (requested ? '共享模式未能开启' : '暂时无法关闭共享模式') : '模式已切换，但设置未保存';
            showSharedFailure(title, sharedStatus.textContent);
        }
    }
    shared.checked = settings.sharedMode === true;
    shared.addEventListener('change', async () => {
        const requested = shared.checked;
        shared.disabled = true;
        sharedStatus.textContent = requested ? '正在检查共享模式兼容性…' : '正在关闭共享模式…';
        let result;
        try {
            const manager = owner.__PT_SHARED_MODE__;
            result = manager ? await manager.setEnabled(requested) : { enabled: false, reasons: ['共享运行接口尚未就绪，请确认已覆盖全部九个扩展文件，刷新并等待酒馆启动完成后重试。'] };
            if (!result || typeof result.enabled !== 'boolean' || !Array.isArray(result.reasons)) throw new Error('Invalid shared mode result');
        } catch {
            let enabled = settings.sharedMode === true;
            try { enabled = owner.__PT_SHARED_MODE__?.diagnostics().enabled === true; } catch {}
            result = { enabled, reasons: ['共享模式检查或切换发生异常，请确认扩展文件完整更新，刷新酒馆后重试。'] };
        }
        try { showSharedResult(result, { requested, interactive: true }); }
        finally { shared.disabled = false; }
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
        onModeChange: value => { showSharedResult({ enabled: value, reasons: [] }); },
    });
    window[CONTROLLER].registerSharedManager?.(window.__PT_SHARED_MODE__);
    if (settings.sharedMode) {
        const restoreSharedMode = async () => {
            if (!settings.sharedMode || !root.isConnected) return;
            const result = await window.__PT_SHARED_MODE__.setEnabled(true);
            showSharedResult(result, { requested: true });
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
