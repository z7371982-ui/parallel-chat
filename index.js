import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import * as core from '../../../../script.js';
import { installScrollQrCompatibility } from './qr-compat.js';
import { installCharacterProfiles, sanitizeProfile } from './character-profiles.js';
import * as nativeOpenAI from '../../../openai.js';

const KEY = 'parallel_tavern';
const CONTROLLER = '__PARALLEL_TAVERN_V2__';
const nativeProxyModules = new WeakMap();
const profileInstances = new WeakMap();
const VERSION = '0.7.6';

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
        // Drop a rejected load so the next attempt can retry.
        nativeProxyModules.get(win).catch(() => { nativeProxyModules.delete(win); });
    }
    return nativeProxyModules.get(win);
}

// 备份旧记录时去掉旧版可能夹带的代理网址、密钥等字段，只留名称。
function stripSecrets(profile) {
    if (!profile || typeof profile !== 'object') return profile;
    const { key, localProxyPresets, proxy, ...rest } = profile;
    return proxy && typeof proxy === 'object' ? { ...rest, proxy: { preset: typeof proxy.preset === 'string' ? proxy.preset : null } } : rest;
}

// Child pages show settings too, but only the main page starts the runtime.
if (window.__PT_CHILD_ID__ || window === window.top) {
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
    // 酒馆助手旧脚本仍在运行时不迁移数据，等停用旧脚本、刷新后再处理。
    const legacy = !child && !!window[CONTROLLER] && typeof window[CONTROLLER].setLauncherVisible !== 'function';
    const runningMode = child ? 'multi-window' : chooseRuntimeMode(settings);
    if (!child) settings.runtimeMode = runningMode;
    const persist = child ? bridge.persist : () => {
        saveSettingsDebounced();
        owner.dispatchEvent(new owner.Event('pt-extension-settings'));
    };
    if (typeof settings.showLauncher !== 'boolean') settings.showLauncher = true;
    if (typeof settings.completionAlert !== 'boolean') settings.completionAlert = true;
    if (typeof settings.completionNotify !== 'boolean') settings.completionNotify = false;
    let backupNote = '';
    if (!child && !legacy && settings.profileSchema !== 2) {
        // 0.7.3 起角色设置只在手动保存时记录；旧版自动生成的记录无法分辨，一次性清空（先留一份备份）。
        const oldProfiles = settings.characterProfiles && typeof settings.characterProfiles === 'object' ? settings.characterProfiles : {};
        if (Object.keys(oldProfiles).length || settings.defaultProfile) {
            settings.characterProfilesBackup = { at: Date.now(), characterProfiles: Object.fromEntries(Object.entries(oldProfiles).map(([id, p]) => [id, stripSecrets(p)])), defaultProfile: stripSecrets(settings.defaultProfile) || null };
            backupNote = '旧版自动记录的角色设置已清空，原记录已备份（扩展设置中的 characterProfilesBackup）。请重新手动保存需要的角色设置。';
        }
        settings.characterProfiles = {}; delete settings.defaultProfile;
        settings.profileSchema = 2; saveSettingsDebounced();
    }
    if (!child) {
    window.__PT_SETTINGS_BRIDGE__ = { settings, persist, getProfile: win => profileInstances.get(win) || null };
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
    // 部分手机主题把 menu_button 压成最小宽度，文字会一字一行竖排；这里固定为横排，按钮放不下时整行换行、文字自动折行。
    root.innerHTML = `
        <style>
        #pt-extension-settings .pt-extension-actions{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
        #pt-extension-settings .pt-extension-actions .menu_button{flex:1 1 8em;width:auto!important;min-width:0;max-width:100%;margin:0;writing-mode:horizontal-tb;white-space:normal;overflow-wrap:anywhere;word-break:normal;justify-content:center;text-align:center}
        #pt-extension-settings .menu_button:disabled{opacity:.5;cursor:not-allowed}
        #pt-extension-settings details>summary{cursor:pointer;margin:6px 0;font-weight:bold}
        #pt-extension-settings .pt-extension-profile-row{display:flex;align-items:center;gap:6px;margin:4px 0}
        #pt-extension-settings .pt-extension-profile-row>span{flex:1;min-width:0;overflow-wrap:anywhere}
        #pt-extension-settings .pt-extension-profile-row .menu_button{flex:none;width:auto!important;margin:0;writing-mode:horizontal-tb;white-space:nowrap}
        </style>
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>并行对话 · ${VERSION}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div id="pt-extension-mode-box" style="border:2px solid var(--SmartThemeQuoteColor,#d2b5c5);border-radius:8px;padding:8px 10px;margin:6px 0;background:rgba(210,181,197,.12)">
                <label for="pt-extension-mode" style="font-weight:bold;font-size:1.05em">⚙ 运行模式切换</label>
                <div style="margin:4px 0">当前运行：<b>${runningMode === 'low-memory' ? '低内存 · 单页面' : '多窗口 · 独立页面'}</b></div>
                <select id="pt-extension-mode" class="text_pole"><option value="low-memory">低内存 · 单页面</option><option value="multi-window">多窗口 · 独立页面</option></select>
                <div id="pt-extension-mode-hint" role="status" style="display:none;margin-top:6px;padding:4px 8px;border-radius:6px;background:rgba(230,170,60,.2);font-weight:bold">⚠ 已选择新模式，点击下方「安全刷新应用模式」后生效</div>
                <small>选择后下次刷新生效。低内存适合苹果及内存有限设备；多窗口保留独立页面。切换选择不会中断当前任务。</small>
                <div class="pt-extension-actions"><button type="button" class="menu_button" id="pt-extension-reload">安全刷新应用模式</button></div>
                </div>
                ${runningMode === 'low-memory' ? '<label class="checkbox_label" for="pt-extension-enabled"><input id="pt-extension-enabled" type="checkbox"><span>开启角色并行</span></label><label class="checkbox_label" for="pt-extension-background-write"><input id="pt-extension-background-write" type="checkbox"><span>后台回复直接存入聊天</span></label><label class="checkbox_label" for="pt-extension-background-progress"><input id="pt-extension-background-progress" type="checkbox"><span>生成途中定时保存进度</span></label><small>进度保存默认关闭；长聊天会增加写入开销。宿主不支持后台写入时，切回会话再处理回复。</small>' : ''}
                <label class="checkbox_label" for="pt-extension-show-launcher">
                    <input id="pt-extension-show-launcher" type="checkbox">
                    <span>显示悬浮窗</span>
                </label>
                <small>拖到左边向左滑、右边向右滑，可收为侧边条，点击展开。黄色：生成中；绿色：有完成回复待查看。关闭入口后会话仍可继续生成。</small>
                <label class="checkbox_label" for="pt-extension-avatar-switch"><input id="pt-extension-avatar-switch" type="checkbox"><span>点击悬浮头像切换对话</span></label>
                <small>默认关闭。开启后点击头像直达对应窗口，点击文字区域仍打开面板。</small>
                <label class="checkbox_label" for="pt-extension-night"><input id="pt-extension-night" type="checkbox"><span>夜间模式</span></label>
                <label class="checkbox_label" for="pt-extension-completion-alert"><input id="pt-extension-completion-alert" type="checkbox"><span>后台回复完成时提醒</span></label>
                <small>标签页标题显示未读数，支持的手机会振动。</small>
                <label class="checkbox_label" for="pt-extension-completion-notify"><input id="pt-extension-completion-notify" type="checkbox"><span>同时发送系统通知</span></label>
                <small>页面在后台时弹出系统通知。</small>
                <label class="checkbox_label" for="pt-extension-character-settings"><input id="pt-extension-character-settings" type="checkbox"><span>按角色记住预设、模型与代理</span></label>
                <small>有专属设置的角色自动换上它的预设、模型与代理；从这类角色切到没有专属设置的角色时换回默认配置，其余情况保持当前设置。默认配置仅在还没有时于启动时取当时设置，之后用「以当前设置为默认配置」更换。平时修改设置不会自动记录；代理网站与密钥始终读取酒馆原生预设。</small>
                <div class="pt-extension-actions">
                <button type="button" class="menu_button" id="pt-extension-adopt-profile">保存为本角色设置</button>
                <button type="button" class="menu_button" id="pt-extension-clear-profile">清除本角色设置</button>
                <button type="button" class="menu_button" id="pt-extension-default-profile">以当前设置为默认配置</button>
                </div>
                <small id="pt-extension-profile-state" style="display:block"></small>
                <details id="pt-extension-profiles">
                <summary>角色设置记录</summary>
                <div id="pt-extension-profile-list"></div>
                <div class="pt-extension-actions">
                <button type="button" class="menu_button" id="pt-extension-export">导出</button>
                <button type="button" class="menu_button" id="pt-extension-import">导入</button>
                </div>
                <input id="pt-extension-import-file" type="file" accept="application/json,.json" hidden>
                <small>导出文件只含角色头像文件名与预设、模型、代理名称，不含代理网址和密钥。</small>
                </details>
                <div class="pt-extension-actions"><button type="button" class="menu_button" id="pt-extension-open">打开并行面板</button></div>
                <small id="pt-extension-status" role="status"></small>
            </div>
        </div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('Extension settings container unavailable');
    container.append(root);
    const checkbox = root.querySelector('#pt-extension-show-launcher');
    const status = root.querySelector('#pt-extension-status');
    if (backupNote) status.textContent = backupNote;
    // 子页面的角色设置实例装在主页面，通过设置接口查询。
    const lookupProfile = win => (child ? bridge.getProfile?.(win) : profileInstances.get(win)) || null;
    const activeProfile = () => lookupProfile(owner[CONTROLLER]?.getActiveWindow?.() || owner);
    const profileState = root.querySelector('#pt-extension-profile-state');
    const refreshProfile = () => {
        let d = null;
        try { d = activeProfile()?.describe?.() || null; } catch {}
        const names = value => ` · 预设 ${value.preset || '—'} · 模型 ${value.model || '—'} · 代理 ${value.proxy || '—'}`;
        profileState.textContent = !d ? '本角色：尚未连接' : d.state === 'off' ? '按角色记住已关闭。'
            : d.state === 'no-character' ? '本角色：当前没有打开单角色聊天'
            : `本角色（${d.name}）：${{ own: '专属设置', default: '使用默认配置', none: '未记录' }[d.state]}${names(d)}${d.failed ? ' · 恢复失败' : ''}`;
    };
    const profileAction = (id, run) => root.querySelector(id).addEventListener('click', () => {
        try {
            const profile = activeProfile();
            if (!profile) throw new Error('当前窗口的角色设置尚未连接，请稍后再试');
            status.textContent = run(profile);
        } catch (error) { status.textContent = String(error?.message || '操作失败'); }
        refreshProfile();
    });
    profileAction('#pt-extension-adopt-profile', p => { p.adoptCurrent(); return '已保存为本角色设置；只保存预设、模型和代理名称。'; });
    profileAction('#pt-extension-clear-profile', p => !p.clearCurrent() ? '这个角色本来就没有专属设置，设置保持不变。'
        : settings.defaultProfile ? '已清除本角色设置，改用默认配置。' : '已清除本角色设置；还没有默认配置，当前设置保持不变。');
    // 以正在看的窗口的当前设置为默认配置。
    profileAction('#pt-extension-default-profile', p => { p.saveDefault(); return '已把当前设置存为默认配置。'; });
    const profileButtons = ['#pt-extension-adopt-profile', '#pt-extension-clear-profile', '#pt-extension-default-profile'].map(id => root.querySelector(id));
    const mode = root.querySelector('#pt-extension-mode');
    mode.value = settings.runtimeMode;
    mode.disabled = child;
    mode.addEventListener('change', () => {
        settings.runtimeMode = mode.value;
        persist();
        root.querySelector('#pt-extension-mode-hint').style.display = mode.value === runningMode ? 'none' : '';
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
        reload.disabled = true;
        status.textContent = '正在保存设置…';
        // 离开页面前必须确认模式已写入服务器。不只等宿主的保存事件（部分宿主不发或发得晚），
        // 保存后再从服务器读回设置核对；读回一致才刷新。
        try {
            if (typeof core.saveSettings !== 'function') throw new Error('宿主不支持立即保存设置');
            const expected = settings.runtimeMode;
            let saved = false;
            for (let attempt = 0; attempt < 2 && !saved; attempt++) {
                await saveNow();
                // 宿主不支持读回或格式不同时，以保存成功为准，不因核对本身失败而卡住。
                const stored = await readBackMode().catch(() => null);
                saved = stored === null || stored === expected;
            }
            if (!saved) throw new Error('服务器上的设置与所选模式不一致');
            if (!controller.canReload()) { status.textContent = '当前有新任务或草稿，请处理后再刷新。'; return; }
            owner.location.reload();
        } catch (error) {
            status.textContent = `设置保存失败：${String(error?.message || error).slice(0, 80)}。所选模式已记下，可稍后再点一次，或等几秒后手动刷新页面。`;
        } finally { reload.disabled = child; }
    });
    // 立即保存一次：宿主保存事件、保存函数返回，任一先到即可；最长等 20 秒。
    function saveNow() {
        const context = owner.SillyTavern.getContext();
        const updated = (context.eventTypes || context.event_types)?.SETTINGS_UPDATED;
        const source = context.eventSource;
        return new Promise((resolve, reject) => {
            const remove = () => { if (updated && source) source.removeListener ? source.removeListener(updated, done) : source.off?.(updated, done); };
            const done = () => { owner.clearTimeout(timeout); remove(); resolve(); };
            const timeout = owner.setTimeout(() => { remove(); reject(new Error('保存超时')); }, 20000);
            if (updated && source?.on) source.on(updated, done);
            Promise.resolve(core.saveSettings()).then(done, error => { owner.clearTimeout(timeout); remove(); reject(error); });
        });
    }
    // 从服务器读回扩展设置里的运行模式；读不到时返回 null。
    async function readBackMode() {
        const context = owner.SillyTavern.getContext();
        const response = await owner.fetch(new URL('api/settings/get', owner.location.href).href, {
            method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(`读取设置失败（HTTP ${response.status}）`);
        const payload = await response.json();
        const stored = typeof payload?.settings === 'string' ? JSON.parse(payload.settings) : payload?.settings;
        return stored?.extension_settings?.[KEY]?.runtimeMode ?? null;
    }
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
    const syncProfileButtons = () => { for (const button of profileButtons) button.disabled = !remember.checked; };
    remember.checked = settings.rememberCharacterSettings !== false;
    syncProfileButtons();
    remember.addEventListener('change', () => {
        settings.rememberCharacterSettings = remember.checked; persist();
        syncProfileButtons(); refreshProfile();
        // 开启后立即为正在看的角色套用记录。
        if (remember.checked) Promise.resolve(activeProfile()?.activate?.()).catch(() => {}).finally(refreshProfile);
    });
    try { night.checked = owner.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch {}
    night.addEventListener('change', () => {
        try { owner.localStorage.setItem('parallel-tavern.night-mode', night.checked ? 'on' : 'off'); } catch {}
        owner[CONTROLLER]?.setNightMode?.(night.checked);
    });
    const alertBox = root.querySelector('#pt-extension-completion-alert');
    const notifyBox = root.querySelector('#pt-extension-completion-notify');
    const syncAlert = () => {
        alertBox.checked = settings.completionAlert !== false;
        notifyBox.checked = settings.completionNotify === true;
        notifyBox.disabled = !alertBox.checked;
    };
    syncAlert();
    alertBox.addEventListener('change', () => { settings.completionAlert = alertBox.checked; persist(); syncAlert(); });
    notifyBox.addEventListener('change', async () => {
        if (!notifyBox.checked) { settings.completionNotify = false; persist(); return; }
        // 运行时在主页面发通知，所以向主页面申请权限；必须在这次点击里同步发起。
        const N = owner.Notification;
        let permission = 'unsupported';
        try {
            if (typeof N?.requestPermission === 'function') {
                permission = N.permission === 'granted' ? 'granted' : await new Promise(resolve => {
                    // 旧版 Safari 只支持回调写法。
                    const result = N.requestPermission(resolve);
                    if (result?.then) result.then(resolve, () => resolve('denied'));
                });
            }
        } catch { permission = 'denied'; }
        if (permission === 'granted') { settings.completionNotify = true; persist(); status.textContent = '已开启系统通知。'; return; }
        settings.completionNotify = false; notifyBox.checked = false; persist();
        status.textContent = permission === 'unsupported' ? '当前浏览器不支持系统通知；iOS 需添加到主屏幕后才支持。' : '浏览器未允许通知，可在网站设置中开启；iOS 需添加到主屏幕后才支持。';
    });
    const details = root.querySelector('#pt-extension-profiles');
    const list = root.querySelector('#pt-extension-profile-list');
    const describeRecord = p => `预设 ${p?.preset || '—'} · 模型 ${p?.model || '—'}${p?.api === 'openai' ? ` · 代理 ${p.proxy?.preset || '—'}` : ''}`;
    // 优先用酒馆弹窗确认；内容用 textContent 放入，不当作 HTML。
    const ask = async text => {
        try {
            const c = window.SillyTavern.getContext();
            if (typeof c.callGenericPopup === 'function' && c.POPUP_TYPE?.CONFIRM != null) {
                const body = document.createElement('div'); body.textContent = text;
                return await c.callGenericPopup(body, c.POPUP_TYPE.CONFIRM) === (c.POPUP_RESULT?.AFFIRMATIVE ?? 1);
            }
        } catch {}
        return window.confirm(text);
    };
    // 只在展开「角色设置记录」时渲染。
    const renderProfiles = () => {
        if (!details.open) return;
        let characters = [];
        try { characters = window.SillyTavern.getContext().characters || []; } catch {}
        const names = new Map(characters.map(c => [c?.avatar, c?.name]));
        const row = (label, text, remove) => {
            const line = document.createElement('div'); line.className = 'pt-extension-profile-row';
            const span = document.createElement('span'), title = document.createElement('b');
            title.textContent = label; span.append(title, document.createTextNode(` ${text}`)); line.append(span);
            if (remove) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'menu_button';
                button.textContent = '删除'; button.setAttribute('aria-label', `删除「${label}」的角色设置`);
                button.addEventListener('click', remove); line.append(button);
            }
            return line;
        };
        const rows = [row('默认配置', settings.defaultProfile ? describeRecord(settings.defaultProfile) : '尚未设置')];
        const entries = Object.entries(settings.characterProfiles || {});
        if (!entries.length) rows.push(row('', '还没有角色专属设置。'));
        for (const [id, p] of entries) {
            const name = names.get(id) || id;
            rows.push(row(name, describeRecord(p), async () => {
                if (!await ask(`删除「${name}」的角色设置？`)) return;
                if (settings.characterProfiles && Object.hasOwn(settings.characterProfiles, id)) delete settings.characterProfiles[id];
                persist(); renderProfiles(); refreshProfile();
                status.textContent = `已删除「${name}」的角色设置。`;
            }));
        }
        list.replaceChildren(...rows);
    };
    details.addEventListener('toggle', renderProfiles);
    root.querySelector('#pt-extension-export').addEventListener('click', () => {
        const characterProfiles = {};
        for (const [id, p] of Object.entries(settings.characterProfiles || {})) { const clean = sanitizeProfile(p); if (clean) characterProfiles[id] = clean; }
        const data = { version: 1, characterProfiles, defaultProfile: sanitizeProfile(settings.defaultProfile) };
        const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `parallel-tavern-profiles-${stamp}.json`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        status.textContent = `已导出 ${Object.keys(characterProfiles).length} 条角色设置${data.defaultProfile ? '和默认配置' : ''}。`;
    });
    const fileInput = root.querySelector('#pt-extension-import-file');
    root.querySelector('#pt-extension-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0]; fileInput.value = '';
        if (!file) return;
        try {
            if (file.size > 1048576) throw new Error('文件过大');
            const data = JSON.parse(await file.text());
            const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
            if (!isObject(data) || data.version !== 1 || !isObject(data.characterProfiles)) throw new Error('不是并行对话导出的角色设置文件');
            // 逐条过滤：只保留名称字段，网址、密钥等其他字段全部丢弃。
            const entries = []; let skipped = 0;
            for (const [id, value] of Object.entries(data.characterProfiles)) {
                const clean = id && id.length <= 1000 && id !== '__proto__' ? sanitizeProfile(value) : null;
                if (clean) entries.push([id, clean]); else skipped++;
            }
            const fallback = data.defaultProfile == null ? null : sanitizeProfile(data.defaultProfile);
            if (data.defaultProfile != null && !fallback) skipped++;
            if (!entries.length && !fallback) throw new Error('文件中没有可用的记录');
            if (!await ask(`合并到现有记录？将导入 ${entries.length} 条角色设置${fallback ? '和默认配置' : ''}，同一角色的现有记录会被覆盖。`)) { status.textContent = '已取消导入。'; return; }
            settings.characterProfiles ||= {};
            for (const [id, clean] of entries) Object.defineProperty(settings.characterProfiles, id, { value: clean, enumerable: true, configurable: true, writable: true });
            if (fallback) settings.defaultProfile = fallback;
            persist(); renderProfiles(); refreshProfile();
            status.textContent = `已导入 ${entries.length} 条角色设置${fallback ? '和默认配置' : ''}${skipped ? `，跳过 ${skipped} 条无效记录` : ''}。`;
        } catch (error) { status.textContent = `导入失败：${error instanceof SyntaxError ? '文件不是有效的 JSON' : error.message}`; }
    });
    root.querySelector('.inline-drawer-toggle').addEventListener('click', refreshProfile);
    refreshProfile();
    const sync = () => {
        checkbox.checked = settings.showLauncher !== false;
        avatarSwitch.checked = settings.avatarQuickSwitch === true;
        remember.checked = settings.rememberCharacterSettings !== false;
        mode.value = settings.runtimeMode;
        if (enabledBox) enabledBox.checked = settings.parallelEnabled === true;
        try { night.checked = owner.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch {}
        syncAlert(); syncProfileButtons(); refreshProfile(); renderProfiles();
    };
    owner.addEventListener('pt-extension-settings', sync);
    owner.addEventListener('pt-night-mode', sync);
    owner.addEventListener('pt-parallel-enabled', sync);
    // 进入往返缓存（bfcache）的页面恢复后还要用这些监听，只在真正卸载时移除。
    const onPageHide = event => { if (!event.persisted) disposeSettings(); };
    const disposeSettings = () => {
        owner.removeEventListener('pt-extension-settings', sync);
        owner.removeEventListener('pt-night-mode', sync);
        owner.removeEventListener('pt-parallel-enabled', sync);
        window.removeEventListener('pagehide', onPageHide);
    };
    window.__PT_SETTINGS_DISPOSE__ = disposeSettings;
    window.addEventListener('pagehide', onPageHide);
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
    if (legacy) {
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
