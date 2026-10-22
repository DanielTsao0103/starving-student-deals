/* Web-only persistence. Every account gets its own cache and durable outbox. */
window.DealsWeb = (() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const config = window.DEALS_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const localKey = 'deals-web-local-v1';
  const sdkURL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  let hooks, client, user = null, channel, rows = {}, outbox = {}, epoch = 0;
  let loadingUsage = false;
  let initializing = configured, flushing = false, problem = '', memoryOnly = false, live = false;
  let pendingAction=null, signinRequested=false, resendTimer=null, problemTimer=null;
  let syncRetryTimer, authSubscription, localUsage = {}, signInBusy = false;
  const inFlight = new Map(), remoteNotices=new Map(), collisions=new Set();
  const limits=new Map(JSON.parse($('deals').textContent).offers.map(o=>[o.id,o.limit]));
  const clamp=(id,n)=>Math.min(limits.get(id)??99,Math.max(0,n));
  function optimistic(id,item){return {used:clamp(id,(rows[id]?.used||0)+(item.deltas||[]).reduce((sum,d)=>sum+d.delta,0)),note:item.note??rows[id]?.note??''};}
  const clean = row => ({used: Math.min(99, Math.max(0, Number.isSafeInteger(row?.used) ? row.used : 0)), note: String(row?.note || '').slice(0, 500)});
  function read(key, fallback = {}) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { memoryOnly = true; return false; }
  }
  function accountKey(id = user?.id) { return 'deals-web-account-v1:' + id; }
  function persist() { if (user) store(accountKey(), {rows, outbox}); }
  function emit() {
    const next = {...rows};
    for (const [id, item] of Object.entries(outbox)) next[id] = optimistic(id,item);
    hooks.onUsage(next); account();
  }
  function account() {
    if (!hooks) return;
    hooks.onLoading(initializing || loadingUsage);
    $('about-title').textContent = 'Your card';$('about-title').hidden=signinRequested;
    document.querySelector('.about-usage').hidden=true;
    $('signin-title').textContent=pendingAction?'Sign in to keep your uses':'Sign in to sync';$('signin-title').hidden=!$('signin-sent').hidden;$('signin-intro').hidden=!$('signin-sent').hidden;$('account-title').hidden=signinRequested;$('account-status').hidden=signinRequested;$('account-privacy').hidden=signinRequested;
    $('signin-open').hidden=Boolean(user)||signinRequested;
    $('account-privacy').textContent=user?"Only you see these uses. Another person's card, such as a spouse's, is tracked under their own sign-in.":"Sign in with your own email to keep uses on all your devices. Each person uses their own email, so counts stay separate.";
    const count = Object.values(outbox).reduce((sum,item)=>sum+(item.deltas?.length||0)+(item.note!==undefined?1:0),0);
    const indicator=$('header-sync');indicator.hidden=!configured||(!user&&navigator.onLine)||navigator.onLine&&!count&&!flushing;indicator.textContent=!navigator.onLine?'Offline':flushing?'Syncing…':count+' waiting';
    const message = !configured ? 'Saved ' + (memoryOnly ? 'for this visit' : 'on this device only') :
      initializing ? 'Connecting to your account…' : !user ? (problem || 'Saved on this device only') :
      memoryOnly ? 'Device storage is full · Keep this page open until synced' :
      !navigator.onLine ? 'Offline · ' + (count ? count + ' changes waiting to sync' : 'Your saved uses are available') :
      problem || (count ? 'Syncing ' + count + ' changes…' : live ? 'Synced across your devices' : 'Saved · Connecting live sync…');
    $('account-status').textContent = message;
    $('about-sync').textContent = message;
    $('account-email').hidden = !user;
    $('account-email').textContent = user?.email || '';
    $('signout').hidden = !user;
    $('signin-panel').hidden = !signinRequested || Boolean(user);
    $('signin-submit').disabled = initializing || signInBusy;
    $('sync-retry').hidden = !configured || !problem;
    const hasLocal = Object.values(localUsage).some(row => row.used || row.note);
    $('merge-panel').hidden = !user || !hasLocal || Boolean(read('deals-web-merge-decided', false));
  }
  function showAccount() { hooks.showAccount(); account(); }
  function canWrite(action=null) {
    if (!configured || (user && !initializing)) return true;
    pendingAction=action;signinRequested=true;showAccount();
    return false;
  }
  async function save(id, next) {
    if (!canWrite({kind:'note',id,note:next.note})) return false;
    next = clean(next);
    if (!configured) {
      rows[id] = next; localUsage = {...rows}; store(localKey, rows); emit(); return true;
    }
    // Persist before acknowledging the optimistic update. The queue survives reloads.
    const current=outbox[id]?optimistic(id,outbox[id]):clean(rows[id]);
    const delta=next.used-current.used,item=outbox[id]||{deltas:[]};
    if(delta)item.deltas.push({delta,token:crypto.randomUUID()});
    if(next.note!==current.note)item.note=next.note;
    outbox[id]={...item,token:crypto.randomUUID()};
    persist(); emit(); void flush(); return true;
  }
  async function flush() {
    if (!user || !client || initializing || flushing || !navigator.onLine) return;
    flushing = true;
    const generation = epoch, owner = user.id;
    clearTimeout(syncRetryTimer);
    try {
      while (generation === epoch && navigator.onLine && Object.keys(outbox).length) {
        const [id, item] = Object.entries(outbox)[0];
        // Each queued action is applied atomically; notes never overwrite a use count.
        const action=item.deltas?.[0],expected=clamp(id,(rows[id]?.used||0)+(action?.delta||0));
        inFlight.set(id,{used:expected,note:rows[id]?.note||''});
        let result;
        if(action){
          result=await client.rpc('bump_usage',{p_offer:id,p_delta:action.delta,p_limit:limits.get(id)??null});
          if(result.error&&(result.error.code==='PGRST202'||result.error.code==='42883'||/function.*not found|could not find.*function/i.test(result.error.message||''))){
            // Compatibility until the separately reviewed RPC migration is deployed.
            const fresh=await client.from('usage').select('*').eq('user_id',owner).eq('offer_id',id).maybeSingle();
            if(fresh.error)throw fresh.error;
            result=await client.from('usage').upsert({user_id:owner,offer_id:id,used:clamp(id,(fresh.data?.used||0)+action.delta),note:fresh.data?.note||''},{onConflict:'user_id,offer_id'}).select().single();
          }
        }else{
          result=await client.from('usage').upsert({user_id:owner,offer_id:id,note:item.note??rows[id]?.note??''},{onConflict:'user_id,offer_id'}).select().single();
        }
        if(generation!==epoch)return;
        inFlight.delete(id);
        if(result.error)throw result.error;
        const data=Array.isArray(result.data)?result.data[0]:result.data;if(action&&data?.used!==expected)collisions.add(id);
        const previous=rows[id];
        if(!previous?.updated_at||!data?.updated_at||data.updated_at>=previous.updated_at)rows[id]={...clean(data),updated_at:data?.updated_at};
        const queued=outbox[id];
        if(action)queued.deltas=queued.deltas.filter(d=>d.token!==action.token);
        else if(queued.token===item.token)delete queued.note;
        if(!queued.deltas.length&&queued.note===undefined){delete outbox[id];if(collisions.has(id)){const limit=limits.get(id);remoteNotices.set(id,'Also used on another device · '+(limit===null?'No limit':clamp(id,limit-rows[id].used)+' of '+limit+' left'));collisions.delete(id);}}
        problem = ''; persist(); emit();
      }
    } catch {
      if (generation === epoch) {
        problem = 'Changes saved on this device. Sync will retry.';
        syncRetryTimer = setTimeout(() => void flush(), 15000);
      }
    } finally {
      if (generation === epoch) { flushing = false; account(); }
    }
  }
  async function refresh(generation = epoch) {
    if (!user || !navigator.onLine) return;
    const owner = user.id;
    try {
      const {data, error} = await client.from('usage').select('*').eq('user_id', owner);
      if (generation !== epoch) return;
      if (error) throw error;
      for (const item of data || []) {
        const old = rows[item.offer_id];
        if (!old?.updated_at || item.updated_at >= old.updated_at)
          rows[item.offer_id] = {...clean(item), updated_at: item.updated_at};
      }
      loadingUsage = false; problem = ''; persist(); emit();
    } catch { if (generation === epoch) { loadingUsage = false; problem = 'Couldn’t refresh your uses. Retry when connected.'; account(); } }
  }
  async function sessionChanged(session) {
    const nextUser = session?.user || null;
    if (!initializing && nextUser?.id === user?.id) { account(); void flush(); void refreshSettings(); return; }
    const generation = ++epoch;
    clearTimeout(syncRetryTimer);clearTimeout(settingsRetryTimer);hooks.onReset();
    if (channel) { void client.removeChannel(channel); channel = null; }
    user = nextUser; settingsFlushing=false;settingsReady=false;const settingsCache=user?read(settingsKey()):{};settings=settingsCache.settings||{};settingsPending=settingsCache.pending||{};hooks.onSettings(user?{...settings,...settingsPending}:null);flushing = false; inFlight.clear(); live = false; problem = '';
    const cached = user ? read(accountKey()) : {};
    rows = cached.rows || {}; outbox = cached.outbox || {};
    loadingUsage = Boolean(user && !cached.rows && navigator.onLine);
    for(const [id,item] of Object.entries(outbox))if(!item.deltas)outbox[id]={deltas:item.used===(rows[id]?.used||0)?[]:[{delta:item.used-(rows[id]?.used||0),token:crypto.randomUUID()}],note:item.note,token:crypto.randomUUID()};
    initializing = false; emit();
    if (!user) return;
    void refreshSettings(generation);
    channel = client.channel('usage:' + user.id).on('postgres_changes',
      {event: '*', schema: 'public', table: 'usage', filter: 'user_id=eq.' + user.id}, payload => {
        if (generation !== epoch) return;
        const item = payload.new, id = item?.offer_id;
        if (!id || item.user_id !== user.id) return;
        const old = rows[id];
        if (old?.updated_at && item.updated_at < old.updated_at) return;
        const ownEcho = JSON.stringify(clean(inFlight.get(id))) === JSON.stringify(clean(item)) && inFlight.has(id);
        const changed = old && JSON.stringify(clean(old)) !== JSON.stringify(clean(item));
        rows[id] = {...clean(item), updated_at: item.updated_at};
        if(!ownEcho&&outbox[id])collisions.add(id);
        persist(); emit();
      }).subscribe(state => {
        if (generation !== epoch) return;
        live = state === 'SUBSCRIBED';
        if (live) { void refresh(generation).then(() => flush()); }
        else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') problem = 'Live sync reconnecting. Your changes are saved.';
        account();
      });
    await refresh(generation);
    if (generation !== epoch) return;
    const action=pendingAction;pendingAction=null;signinRequested=false;if(action){hooks.closeAccount();hooks.replay(action);}
    void flush();
    if (!$('merge-panel').hidden) showAccount();
  }
  async function connect() {
    if (!configured) return;
    try {
      if (!window.supabase) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = sdkURL;
        script.onload = resolve; script.onerror = reject; document.head.append(script);
      });
      client ||= window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}
      });
      if (!authSubscription) authSubscription = client.auth.onAuthStateChange((_event, session) => {
        // Supabase holds its auth lock here; defer database calls until it releases it.
        setTimeout(() => void sessionChanged(session), 0);
      }).data.subscription;
      const {data, error} = await client.auth.getSession();
      if (error) throw error;
      await sessionChanged(data.session);
    } catch {
      initializing = false; problem = 'Sign-in is unavailable right now. You can still browse.'; account();
    }
  }
  async function sendLink(event) {
    event.preventDefault(); if (signInBusy) return;
    const email = $('signin-email').value.trim();
    signInBusy = true; $('signin-status').dataset.state = 'sending';
    $('signin-status').textContent = '';
    $('signin-submit').textContent = 'Sending…'; account();
    try {
      if (!client) await connect();
      if (!client) throw new Error('Unavailable');
      const {error} = await client.auth.signInWithOtp({email, options: {emailRedirectTo: location.origin + location.pathname}});
      if (error) throw error;
      $('signin-status').dataset.state = 'sent';
      $('signin-form').hidden=true;$('signin-sent').hidden=false;
      $('sent-message').textContent='We sent a sign-in link to '+email+". Open it on this device. Check spam if it hasn't arrived in a minute.";
      let seconds=30;$('resend').disabled=true;$('resend').setAttribute('aria-disabled','true');$('resend').textContent='Resend in 30s';clearInterval(resendTimer);resendTimer=setInterval(()=>{seconds--;$('resend').textContent=seconds?'Resend in '+seconds+'s':'Resend';if(!seconds){clearInterval(resendTimer);$('resend').disabled=false;$('resend').setAttribute('aria-disabled','false');}},1000);
      $('signin-submit').textContent='Email me a sign-in link';
    } catch {
      $('signin-status').dataset.state = 'error';
      $('signin-status').textContent = 'Couldn’t send the link. Check your connection and email, then try again.';
      $('signin-submit').textContent = 'Try again';
    } finally { signInBusy = false; account(); }
  }
  function mergeUsage(a,b){return clean({used:(a.used||0)+(b.used||0),note:[...new Set([a.note,b.note].flatMap(n=>(n||'').split('\n')).filter(Boolean))].join('\n')});}
  async function mergeLocal(keep) {
    if (!user) return;
    if (keep) {
      for (const [id, local] of Object.entries(localUsage)) {
        const remote = outbox[id] || rows[id] || {};
        outbox[id] = {deltas:[...(outbox[id]?.deltas||[]),...(local.used?[{delta:local.used,token:crypto.randomUUID()}]:[])],note:mergeUsage(remote,local).note,token:crypto.randomUUID()};
      }
      persist(); emit();
    }
    store('deals-web-merge-decided', true); account(); void flush();
  }
  // Settings use a separate, account-scoped outbox; coordinates are never accepted.
  let settings = {}, settingsPending = {}, settingsFlushing = false, settingsReady = false;
  let settingsRetryTimer;
  function settingsKey() { return 'deals-web-settings-v1:' + user?.id; }
  function persistSettings() { if(user)store(settingsKey(), {settings, pending:settingsPending}); }
  function saveSettings(patch) {
    if(!user)return;
    if(patch.location_opt_in === true)settingsPending.location_opt_in=true;
    if(Object.hasOwn(patch,'home_city'))settingsPending.home_city=typeof patch.home_city==='string'?patch.home_city.slice(0,120):null;
    persistSettings();void flushSettings();
  }
  async function refreshSettings(generation=epoch) {
    if(!user||!client||!navigator.onLine)return;
    const owner=user.id;
    try {
      const {data,error}=await client.from('user_settings').select('location_opt_in,home_city,updated_at').eq('user_id',owner).maybeSingle();
      if(generation!==epoch)return;
      if(error)throw error;
      settings=data||{};settingsReady=true;
      const device=hooks.getLocationSettings();
      if(device.location_opt_in&&!settings.location_opt_in)settingsPending.location_opt_in=true;
      // A saved city on a new account can seed its preference, but never overwrite a remote choice on load.
      if(!settings.home_city&&device.home_city&&!Object.hasOwn(settingsPending,'home_city'))settingsPending.home_city=device.home_city;
      persistSettings();hooks.onSettings({...settings,...settingsPending});void flushSettings();
    }catch {
      if(generation===epoch){
        // Migration may not be deployed yet; device location remains fully usable.
        clearTimeout(settingsRetryTimer);settingsRetryTimer=setTimeout(()=>void refreshSettings(generation),30000);
      }
    }
  }
  async function flushSettings() {
    if(!user||!client||!settingsReady||settingsFlushing||!navigator.onLine||!Object.keys(settingsPending).length)return;
    settingsFlushing=true;const generation=epoch,owner=user.id;
    try {
      while(generation===epoch&&Object.keys(settingsPending).length){
        const patch={...settingsPending};
        const next={user_id:owner,location_opt_in:settings.location_opt_in===true||patch.location_opt_in===true,
          home_city:Object.hasOwn(patch,'home_city')?patch.home_city:settings.home_city||null,updated_at:new Date().toISOString()};
        const {error}=await client.from('user_settings').upsert(next,{onConflict:'user_id'});
        if(generation!==epoch)return;
        if(error)throw error;
        settings=next;
        for(const [key,value] of Object.entries(patch))if(settingsPending[key]===value)delete settingsPending[key];
        persistSettings();hooks.onSettings(settings);
      }
    }catch {
      if(generation===epoch){clearTimeout(settingsRetryTimer);settingsRetryTimer=setTimeout(()=>void refreshSettings(generation),15000);}
    }finally{if(generation===epoch)settingsFlushing=false;}
  }
  function init(callbacks) {
    hooks = callbacks;const indicator=document.createElement('span');indicator.id='header-sync';indicator.className='header-sync';indicator.hidden=true;$('about-button').after(indicator);localUsage = read(localKey);
    if (!configured) rows = {...localUsage};
    $('signin-form').onsubmit = sendLink;
    $('signin-open').onclick=()=>{signinRequested=true;account();};
    $('signin-cancel').onclick=()=>{pendingAction=null;signinRequested=false;account();hooks.closeAccount();};
    $('different-email').onclick=()=>{$('signin-form').hidden=false;$('signin-sent').hidden=true;$('signin-status').textContent='';account();$('signin-email').focus();};
    $('resend').onclick=sendLink;
    const install=document.createElement('div');install.className='install-row';install.innerHTML='<button class="summary-row" aria-expanded="false">Add to Home Screen <svg viewBox="0 0 24 24" aria-hidden="true" class="install-chevron icon icon-chevron-right"> <path d="M9 6l6 6l-6 6" /></svg></button><p hidden>On iPhone, use Safari’s Share menu, then Add to Home Screen. On a laptop, use your browser’s install button.</p>';install.querySelector('button').onclick=()=>{const button=install.querySelector('button'),open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));install.querySelector('p').hidden=!open;};
    install.hidden=matchMedia('(display-mode:standalone)').matches||navigator.standalone===true;document.querySelector('.about-lines').after(install);
    if(!install.hidden&&/iPhone|iPad|iPod/.test(navigator.userAgent)&&/Safari/.test(navigator.userAgent)&&!read('deals-install-dismissed',false)){const hint=document.createElement('div');hint.className='install-hint';hint.append(document.createTextNode('Add to Home Screen from Share for offline use'));const close=document.createElement('button');close.className='text-button';close.textContent='Dismiss';close.onclick=()=>{store('deals-install-dismissed',true);hint.remove();};hint.append(close);$('results').before(hint);}

    $('merge-keep').onclick = () => void mergeLocal(true);
    $('merge-skip').onclick = () => void mergeLocal(false);
    $('sync-retry').onclick = () => { problem = ''; if (!client || !user) void connect(); else void refresh().then(flush); };
    $('signout').onclick = async () => {
      $('signout').disabled = true;
      try {
        const {error} = await client.auth.signOut({scope: 'local'});
        if (error) throw error;
        await sessionChanged(null);
      } catch { problem = 'Couldn’t sign out. Please try again.'; account(); }
      finally { $('signout').disabled = false; }
    };
    emit(); void connect();
    addEventListener('online', () => { account(); if (user) {void refresh().then(flush);void refreshSettings();} else if (configured) void connect(); });
    addEventListener('offline', account);
    addEventListener('storage', event => {
      if (!configured && event.key === localKey) { rows = read(localKey); localUsage = {...rows}; emit(); }
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {
      $('account-status').textContent = 'Offline setup unavailable. Reload when connected.';
    });
  }
  return {init, save, saveSettings, canWrite, account,notice:id=>remoteNotices.get(id),clearNotice:id=>remoteNotices.delete(id)};
})();
