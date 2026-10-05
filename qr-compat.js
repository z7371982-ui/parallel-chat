// Adapter for Junezz's supplied 回顶/回底 v1.1. No script settings or content
// are changed. Match the helper's script container AND its actual source.
export function installScrollQrCompatibility(surface, getActiveWindow) {
    let popup = null;
    function knownScript(button) {
        const group = button.closest('[id^="script_container_"]');
        if (!group) return false;
        const id = group.id.slice('script_container_'.length);
        return [...surface.document.querySelectorAll('iframe')].some(frame => {
            if (![frame.id, frame.name].some(n => n?.startsWith('TH-script--') && n.endsWith('--' + id))) return false;
            try {
                return [...frame.contentDocument.scripts].some(s => {
                    const code = s.textContent || '';
                    return code.includes('SillyTavern Scroll Buttons') && code.includes('window.top.document')
                        && code.includes('function scrollToMessageByMesId()') && code.includes('function scrollToAbsoluteBottom()');
                });
            } catch { return false; }
        });
    }
    function scroller(w) {
        const d = w.document;
        let el = d.querySelector('#chat .mes[mesid], .mes[mesid]')?.parentElement;
        while (el && el !== d.body) {
            if (el.clientHeight && el.scrollHeight > el.clientHeight && /auto|scroll/.test(w.getComputedStyle(el).overflowY)) return el;
            el = el.parentElement;
        }
        return d.querySelector('#chat, #dialogue, .chat-container, #chat_story_container, .list-messages, .chatdisplay') || d.scrollingElement;
    }
    function messages(container) {
        return [...container.querySelectorAll('.mes[mesid]')].filter(n => /^\d+$/.test(n.getAttribute('mesid')) && n.getBoundingClientRect().height > 0)
            .sort((a,b) => Number(a.getAttribute('mesid')) - Number(b.getAttribute('mesid')));
    }
    function top(w,c) { return c === w.document.scrollingElement ? 0 : c.getBoundingClientRect().top + c.clientTop; }
    function move(w,c,node,end=false) {
        c.scrollTo({top:c.scrollTop + node.getBoundingClientRect().top - top(w,c) + (end ? node.getBoundingClientRect().height-c.clientHeight : 0),behavior:'instant'});
    }
    function close() { if (!popup) return; try { popup.close(); } catch {} popup.remove(); popup=null; }
    function run(label,w) {
        const c=scroller(w), all=messages(c);
        if (!all.length) { w.toastr?.info?.('当前没有已加载的消息。'); return; }
        const current=all.find(n=>n.getBoundingClientRect().bottom>top(w,c)) || all[all.length-1];
        if(label==='回底') {move(w,c,all[all.length-1],true);return;}
        if(label==='回顶') {
            const i=all.indexOf(current), near=Math.abs(current.getBoundingClientRect().top-top(w,c))<35;
            move(w,c,near&&i>0?all[i-1]:current);return;
        }
        close();
        const d=w.document, dialog=d.createElement('dialog');popup=dialog;
        dialog.dataset.ptQrCompat='true';dialog.setAttribute('aria-label','跳转楼层');
        dialog.style.cssText='max-width:90vw;width:420px;box-sizing:border-box;padding:24px;border:1px solid #d9ceca;border-radius:16px;background:#fcfbf9;color:#61545b;';
        try { if (surface.localStorage.getItem('parallel-tavern.night-mode') === 'on') dialog.style.cssText += 'color-scheme:dark;background:#242126;color:#eee7eb;border-color:#494149;'; } catch {}
        const title=d.createElement('h3');title.textContent='跳转';
        const info=d.createElement('p');info.textContent='当前楼层：#'+current.getAttribute('mesid')+' ｜ 已加载：#'+all[0].getAttribute('mesid')+'—#'+all.at(-1).getAttribute('mesid');
        const input=d.createElement('input');input.type='number';input.min='0';input.step='1';input.value=current.getAttribute('mesid');input.setAttribute('aria-label','目标楼层');input.style.cssText='width:100%;box-sizing:border-box;margin-bottom:12px';
        const status=d.createElement('p');status.setAttribute('role','status');
        function jump(value) {
            if(getActiveWindow()!==w) {close();return;}
            if(!/^\d+$/.test(value)) {status.textContent='请输入非负整数楼层。';return;}
            const next=scroller(w), node=messages(next).find(n=>Number(n.getAttribute('mesid'))===Number(value));
            if(!node){status.textContent='该楼层尚未加载，请先加载历史消息后重试。';return;}
            close();w.requestAnimationFrame(()=>{if(getActiveWindow()===w)move(w,next,node);});
        }
        function button(text,action){const b=d.createElement('button');b.type='button';b.textContent=text;b.className='menu_button';b.style.margin='4px';b.addEventListener('click',action);return b;}
        dialog.append(title,info,input,status,
            button('回顶10层',()=>jump(String(Math.max(0,Number(current.getAttribute('mesid'))-10)))),
            button('回顶20层',()=>jump(String(Math.max(0,Number(current.getAttribute('mesid'))-20)))),
            button('确定',()=>jump(input.value)),button('取消',close));
        dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
        input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();jump(input.value);}});
        d.body.append(dialog);dialog.showModal();input.focus();input.select();
    }
    const click = event => {
        const button=event.target?.closest?.('.qr--button');
        const label=button?.textContent.trim();
        if(!['回顶','回底','回楼层'].includes(label)||!knownScript(button))return;
        event.preventDefault();event.stopImmediatePropagation();
        run(label,getActiveWindow());
    };
    surface.addEventListener('click',click,true);
    return ()=>{surface.removeEventListener('click',click,true);close();};
}
