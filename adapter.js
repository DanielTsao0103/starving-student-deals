/* Web-only persistence. Every account gets its own cache and durable outbox. */
window.DealsWeb = (() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const config = window.DEALS_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const localKey = 'deals-web-local-v1';
  let hooks, client, user = null, channel, rows = {}, outbox = {}, epoch = 0;
  let loadingUsage = false, lastSynced=0;
  let retryDelay=15000;
  let initializing = configured, flushing = false, problem = '', memoryOnly = false, live = false;
  let pendingAction=null, signinRequested=false, resendTimer=null;
  let authMode='create', authStep='email', authAttempt=null, verifyBusy=false, resendAt=0;
  let welcome='', onboarding=false, newAccount=false, mergePending=false, mergeReceipt=null;
  let signOutBusy=false;
  const offers=new Map();
  const setText=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
  const plural=(count,word)=>count+' '+word+(count===1?'':'s');
  let syncRetryTimer, authSubscription, localUsage = {}, signInBusy = false;
  const inFlight = new Map(), remoteNotices=new Map(), collisions=new Set();
  const limits=new Map();
  function updateCatalog(items) {offers.clear();limits.clear();for(const o of items){offers.set(o.id,o);limits.set(o.id,o.limit);}}
  const clamp=(id,n)=>Math.min(limits.get(id)??Number.MAX_SAFE_INTEGER,Math.max(0,n));
  function optimistic(id,item){return {used:clamp(id,(rows[id]?.used||0)+(item.deltas||[]).reduce((sum,d)=>sum+d.delta,0)),note:item.note??rows[id]?.note??''};}
  const clean = row => ({used: Math.max(0, Number.isSafeInteger(row?.used) ? row.used : 0), note: String(row?.note || '').slice(0, 500)});
  function read(key, fallback = {}) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); memoryOnly=false;hooks?.saveFailure?.(false);return true; }
    catch { memoryOnly = true;hooks?.saveFailure?.(true);return false; }
  }
  function accountKey(id = user?.id) { return 'deals-web-account-v1:' + id; }
  function persist() { return user ? store(accountKey(), {rows, outbox, mergeReceipt}) : false; }
  function remove(key) { try { localStorage.removeItem(key); } catch { memoryOnly=true; } }
  function knownEmail() { try { return localStorage.getItem('deals-known-email') || ''; } catch { return ''; } }
  function rememberEmail(email) { try { localStorage.setItem('deals-known-email',email); } catch { memoryOnly=true; } }
  function localFingerprint() { return JSON.stringify(Object.entries(localUsage).sort(([a],[b])=>a.localeCompare(b))); }
  function differences() {
    return Object.entries(localUsage).filter(([id])=>offers.has(id)).map(([id,local])=>{
      const remote=outbox[id]?optimistic(id,outbox[id]):clean(rows[id]);
      return {id,local:clean(local),remote,delta:Math.max(0,clamp(id,local.used||0)-remote.used),
        note:local.note && !remote.note.split('\n').includes(local.note) ? local.note : ''};
    }).filter(item=>item.delta||item.note);
  }
  function renderMerge() {
    const changes=differences(),count=changes.reduce((n,item)=>n+item.delta,0);
    setText('merge-title',newAccount?'Add your device uses?':'Choose which uses to keep');
    const remote=Object.values(rows),uses=remote.reduce((n,row)=>n+row.used,0),deals=remote.filter(row=>row.used>0).length;
    setText('merge-message','Your account has '+plural(uses,'use')+' on '+plural(deals,'deal')+'. This device has '+count+' more.');
    setText('merge-keep',newAccount?'Add':'Keep both');setText('merge-skip',"Discard this device's uses");
    const list=$('merge-differences');list.replaceChildren();
    for(const item of changes){
      const li=document.createElement('li'),title=document.createElement('strong'),detail=document.createElement('span');
      title.textContent=offers.get(item.id).business;
      const count=document.createElement('span');count.className='merge-count';count.textContent=item.delta?'+'+item.delta:'';title.append(count);
      detail.textContent=offers.get(item.id).offer;
      li.append(title,detail);list.append(li);
    }
  }
  function renderAuth() {
    const busy=signInBusy||verifyBusy;
    $('signin-form').hidden=authStep!=='email';$('signin-sent').hidden=authStep!=='code';
    $('signin-title').hidden=authStep==='code';$('signin-intro').hidden=authStep==='code';
    document.querySelector('.auth-modes').hidden=authStep==='code';
    for(const mode of ['signin','create']){
      $('auth-'+mode).setAttribute('aria-pressed',String(authMode===mode));$('auth-'+mode).disabled=busy;
    }
    setText('signin-intro',pendingAction?.kind==='use'?"Create an account to save this use. It's added as soon as you're in.":'Use your own email. Each person has a separate card.');
    setText('signin-title',authMode==='signin'?'Welcome back':'Track your card on all your devices');
    setText('signin-submit',signInBusy?'Sending…':authMode==='signin'?'Email me a code':'Create account');
    $('signin-submit').disabled=initializing||busy;
    $('signin-email').readOnly=busy;$('signin-code').readOnly=busy;
    $('code-submit').disabled=busy;setText('code-submit',verifyBusy?'Verifying…':'Verify code');
    $('different-email').disabled=busy;$('unknown-create').disabled=busy;
    $('not-you').hidden=authStep!=='email'||!knownEmail()||!$('signin-email').value;
    updateCountdown();
  }
  function updateCountdown() {
    const seconds=Math.max(0,Math.ceil((resendAt-Date.now())/1000));
    $('resend').disabled=seconds>0||signInBusy||verifyBusy;
    setText('resend',seconds?'Resend code in '+seconds+'s':'Resend code');
    if(!seconds){clearInterval(resendTimer);resendTimer=null;}
  }
  function cooldown(seconds=60) {
    resendAt=Date.now()+seconds*1000;clearInterval(resendTimer);
    resendTimer=setInterval(updateCountdown,1000);updateCountdown();
  }
  function authError(message) {
    $('signin-status').dataset.state=message?'error':'';setText('signin-status',authStep==='code'?'':message);setText('code-help',authStep==='code'&&message?message:'The code expires in 10 minutes. Check your newest email.');$('code-help').classList.toggle('auth-error',Boolean(message)&&authStep==='code');
    $('signin-code').setAttribute('aria-invalid',String(Boolean(message)&&authStep==='code'));
  }
  function chooseMode(mode) {
    if(signInBusy||verifyBusy)return;
    authMode=mode;authStep='email';authAttempt=null;remove('deals-auth-attempt');
    $('unknown-create').hidden=true;authError('');renderAuth();
  }
  function openSignin() {
    signinRequested=true;welcome='';authMode=knownEmail()?'signin':'create';
    if(authStep==='email')$('signin-email').value=knownEmail();
    account();
  }
  function emit() {
    const next = {...rows};
    for (const [id, item] of Object.entries(outbox)) next[id] = optimistic(id,item);
    hooks.onUsage(next); account();
  }
  function account() {
    if (!hooks) return;
    hooks.onLoading(initializing || loadingUsage);
    const authenticating=signinRequested&&!user,focused=authenticating||mergePending||Boolean(welcome);
    // Keep AUTH.md's complete new-account receipt in the live status below.
    // A neutral sheet title avoids announcing the same greeting twice.
    setText('about-title',authenticating&&authStep==='code'?'Check your email':welcome?(newAccount?'Your card':'Welcome back'):focused?'Account':'Your card');$('about-title').hidden=false;
    $('about-sheet').classList.toggle('account-focused',focused);
    document.querySelector('.about-usage').hidden=true;
    $('account-title').hidden=focused;$('account-status').hidden=authenticating||mergePending||Boolean(welcome);
    $('account-privacy').hidden=authenticating||mergePending||Boolean(welcome);
    $('signin-open').hidden=Boolean(user)||signinRequested||!configured;
    setText('account-privacy',user?'Your uses are private to you.':'Each person uses their own email and has a separate card.');
    const count = Object.values(outbox).reduce((sum,item)=>sum+(item.deltas?.length||0)+(item.note!==undefined?1:0),0);
    const indicator=$('header-sync'),hidden=!configured||(!problem&&((!user&&navigator.onLine)||navigator.onLine&&!count&&!flushing)),label=problem?'Not syncing · '+count+' saved here':!navigator.onLine?'Offline':flushing?'Syncing…':count+' waiting';if(indicator.hidden!==hidden)indicator.hidden=hidden;if(indicator.textContent!==label)indicator.textContent=label;
    const message = !configured ? 'Saved ' + (memoryOnly ? 'for this visit' : 'on this device only') :
      initializing ? 'Connecting to your account…' : !user ? (problem || 'Saved on this device only') :
      memoryOnly ? 'Device storage is full · Keep this page open until synced' :
      !navigator.onLine ? 'Offline · ' + (count ? count + ' changes waiting to sync' : 'Your saved uses are available') :
      problem || (count ? 'Syncing ' + count + ' changes…' : live ? 'Synced just now' : 'Saved · Connecting live sync…');
    const allRows={...rows};for(const [id,item] of Object.entries(outbox))allRows[id]=optimistic(id,item);const values=Object.values(allRows),uses=values.reduce((n,row)=>n+row.used,0),deals=values.filter(row=>row.used>0).length;
    const stale=lastSynced&&Date.now()-lastSynced>300000;
    const syncLabel=stale?'Last synced '+Math.floor((Date.now()-lastSynced)/60000)+' min ago':'Synced just now';
    const result=(uses?plural(uses,'use')+' on '+plural(deals,'deal')+' · ':'')+(!navigator.onLine?'saved offline':count?'syncing':problem?'saved here':syncLabel);
    $('account-status').textContent = user&&!problem?result:message;
    $('last-synced').hidden=true;setText('last-synced','');
    $('about-sync').textContent = message;
    $('account-email').hidden = !user;
    setText('account-email',user?.email||'');
    $('signout').hidden = !user||mergePending||Boolean(welcome);
    $('signin-panel').hidden = !signinRequested || Boolean(user);
    $('signout-help').hidden=true;renderAuth();
    $('auth-success').hidden=!welcome||mergePending;setText('auth-welcome',newAccount?"You're all set. Uses you mark now sync to your other devices.":uses?plural(uses,'use')+' on '+plural(deals,'deal'):'Your card is ready.');if(welcome)$('auth-welcome').after($('account-email'));else $('account-status').after($('account-email'));
    $('sync-retry').hidden = !configured || !problem;
    $('merge-panel').hidden=!user||!mergePending;
  }
  function showAccount() { hooks.showAccount(); account(); requestAnimationFrame(()=>document.querySelector('.account')?.scrollIntoView({block:'start'})); }
  function canWrite(action=null) {
    if (!configured || (user && !initializing && !loadingUsage && !mergePending && !onboarding && !signOutBusy)) return true;
    pendingAction=action;if(!user)openSignin();showAccount();
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
    if (!user || !client || initializing || loadingUsage || flushing || signOutBusy || !navigator.onLine) return;
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
          // A persisted operation ID survives retries and reloads. Never fall back
          // to read/overwrite: that would lose concurrent uses or apply a retry twice.
          result=await client.rpc('bump_usage',{p_offer_id:id,p_delta:action.delta,p_op_id:action.token});
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
        if(!queued.deltas.length&&queued.note===undefined){delete outbox[id];if(collisions.has(id)){const limit=limits.get(id);remoteNotices.set(id,'Updated');collisions.delete(id);}}
        problem = '';lastSynced=Date.now();retryDelay=15000; persist(); emit();
      }
    } catch {
      if (generation === epoch) {
        problem = 'Changes saved on this device. Sync will retry.';
        clearTimeout(syncRetryTimer);syncRetryTimer=setTimeout(()=>void flush(),retryDelay);retryDelay=Math.min(60000,retryDelay*2);
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
      loadingUsage = false; problem = '';lastSynced=Date.now();retryDelay=15000; persist(); emit();
      if(onboarding)finishSignin();
    } catch { if (generation === epoch) { loadingUsage = false; problem = 'Couldn’t refresh your uses. Retry when connected.'; account(); } }
  }
  async function sessionChanged(session) {
    const nextUser = session?.user || null;
    if (!initializing && nextUser?.id === user?.id) { account(); void flush(); void refreshSettings(); return; }
    const previousUser=user;
    const generation = ++epoch;
    if(previousUser && previousUser.id!==nextUser?.id){
      remove(accountKey(previousUser.id));remove('deals-web-settings-v1:'+previousUser.id);
      localUsage={};remove(localKey);welcome='';mergePending=false;onboarding=false;pendingAction=null;
      remoteNotices.clear();collisions.clear();
    }
    clearTimeout(syncRetryTimer);clearTimeout(settingsRetryTimer);hooks.onReset();
    if (channel) { void client.removeChannel(channel); channel = null; }
    user = nextUser; settingsFlushing=false;settingsReady=false;const settingsCache=user?read(settingsKey()):{};settings=settingsCache.settings||{};settingsPending=settingsCache.pending||{};hooks.onSettings(user?{...settings,...settingsPending}:null);flushing = false; inFlight.clear(); live = false; problem = '';
    const cached = user ? read(accountKey()) : {};
    rows = cached.rows || {}; outbox = cached.outbox || {};mergeReceipt=cached.mergeReceipt||null;
    if(user){
      authAttempt ||= read('deals-auth-attempt',null);
      onboarding=Boolean(authAttempt?.email===user.email)||differences().length>0;
      if(mergeReceipt===localFingerprint()){localUsage={};remove(localKey);}
      rememberEmail(user.email);signinRequested=false;
    }else{authMode=knownEmail()?'signin':'create';$('signin-email').value=knownEmail();}
    loadingUsage = Boolean(user && navigator.onLine);
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
        if(!ownEcho&&outbox[id])collisions.add(id);else if(!ownEcho&&changed)remoteNotices.set(id,'Updated');
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
    void flush();
  }
  async function connect() {
    if (!configured) return;
    try {
      client ||= await window.DealsCatalog.getClient();
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
  /** Request a code in the chosen mode; resends retain the first request time. */
  async function sendCode(event) {
    event?.preventDefault();if(signInBusy||verifyBusy)return;
    if(authStep==='code'&&Date.now()<resendAt)return;
    if(!$('signin-form').reportValidity())return;
    const email=$('signin-email').value.trim().toLowerCase();
    const startedAt=authAttempt?.email===email?authAttempt.startedAt:Date.now();
    signInBusy=true;authError('');$('unknown-create').hidden=true;renderAuth();
    try {
      if(!client)await connect();
      if(!client)throw new Error('Unavailable');
      const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:authMode==='create',
        emailRedirectTo:location.origin+location.pathname}});
      if(error)throw error;
      authAttempt={email,mode:authMode,startedAt,sentAt:Date.now()};store('deals-auth-attempt',authAttempt);
      authStep='code';$('signin-code').value='';paintCode();
      setText('sent-message','Enter the 6-digit code sent to '+email);
      cooldown();renderAuth();$('signin-code').focus();
    }catch(error){
      if(authMode==='signin'&&(error.code==='otp_disabled'||error.code==='user_not_found'||/signups? (?:not allowed|disabled)|user not found/i.test(error.message||''))){
        authError("No account for "+email+' yet.');$('unknown-create').hidden=false;
      }else authError(authErrorMessage(error,false));
    }finally{signInBusy=false;account();}
  }
  function authErrorMessage(error,verifying) {
    const message=error.message||'',code=error.code||'';
    if(error.status===429||/rate_limit|over_email_send|over_request/.test(code)||/rate limit|too many|after .*seconds/i.test(message)){
      const seconds=Number(error.retryAfter)||Number(message.match(/after (\d+) seconds/i)?.[1]);
      if(seconds)cooldown(Math.max(seconds,60));
      return 'Too many emails right now. '+(seconds?'Try again in '+plural(seconds,'second')+'.':'Try again in a few minutes.');
    }
    // GoTrue can use one error for both invalid and expired tokens. Use the
    // known delivery time only to disambiguate that combined response.
    const ambiguous=/expired.*invalid|invalid.*expired/i.test(message);
    const expired=ambiguous?Date.now()-(authAttempt?.sentAt||0)>=600000:code==='otp_expired'||/expired/i.test(message);
    if(verifying&&expired)return 'That code expired. Send a new one.';
    if(verifying&&ambiguous)return "That code isn't right. Check the newest email.";
    if(verifying&&(error.status===400||error.status===403||/invalid|wrong/.test(code)))return "That code isn't right. Check the newest email.";
    return verifying?'Couldn’t verify the code. Check your connection and try again.':'Couldn’t send the code. Check your connection and email, then try again.';
  }
  function paintCode() {
    const input=$('signin-code'),digits=input.value.replace(/\D/g,'').slice(0,6);input.value=digits;
    document.querySelectorAll('.code-boxes span').forEach((box,index)=>{
      box.textContent=digits[index]||'';box.classList.toggle('current',index===Math.min(digits.length,5));
    });
  }
  async function verifyCode(event) {
    event?.preventDefault();if(verifyBusy||signInBusy||!authAttempt||!/^\d{6}$/.test($('signin-code').value))return;
    verifyBusy=true;authError('');renderAuth();
    try {
      const {data,error}=await client.auth.verifyOtp({email:authAttempt.email,token:$('signin-code').value,type:'email'});
      if(error)throw error;
      if(!data.session)throw new Error('Missing session');
      clearInterval(resendTimer);await sessionChanged(data.session);
    }catch(error){
      authError(authErrorMessage(error,true));
      if(!matchMedia('(prefers-reduced-motion:reduce)').matches)document.querySelector('.code-field').animate(
        [{transform:'translateX(0)'},{transform:'translateX(-6px)'},{transform:'translateX(6px)'},{transform:'translateX(-3px)'},{transform:'translateX(0)'}],{duration:220});
      $('signin-code').focus();$('signin-code').select();
    }finally{verifyBusy=false;account();}
  }
  function finishSignin() {
    if(!user||loadingUsage)return;
    onboarding=false;
    newAccount=authAttempt?.mode==='create'&&Date.parse(user.created_at)>=authAttempt.startedAt-1000;
    const hasAttempt=Boolean(authAttempt),already=authAttempt?.mode==='create'&&!newAccount;
    mergePending=differences().length>0;
    const used=Object.values(rows).reduce((n,row)=>n+row.used,0),deals=Object.values(rows).filter(row=>row.used>0).length;
    welcome=newAccount?"You're all set. Uses you mark now sync to your other devices.":
      already?'Welcome back. You already had an account, so your card is synced.':
      'Welcome back. Your card is synced: '+plural(used,'use')+' on '+plural(deals,'deal')+'.';
    authAttempt=null;remove('deals-auth-attempt');authStep='email';$('signin-code').value='';paintCode();
    clearInterval(resendTimer);resendAt=0;
    if(mergePending)renderMerge();
    if(hasAttempt||mergePending){showAccount();$('about-title').focus({preventScroll:true});}else{welcome='';account();}
  }
  /** Commit receipt + outbox together before consuming the anonymous device cache. */
  async function mergeLocal(keep) {
    if(!user||!mergePending)return;
    const fingerprint=localFingerprint();
    if(keep&&mergeReceipt!==fingerprint){
      for(const item of differences()){
        const queued=outbox[item.id]||{deltas:[]};
        if(item.delta)queued.deltas.push({delta:item.delta,token:crypto.randomUUID()});
        if(item.note)queued.note=[...new Set([item.remote.note,item.note].filter(Boolean))].join('\n').slice(0,500);
        outbox[item.id]={...queued,token:crypto.randomUUID()};
      }
    }
    mergeReceipt=fingerprint;persist();localUsage={};remove(localKey);mergePending=false;
    welcome=keep?'Your device uses were added.'+(!navigator.onLine?' They sync when connected.':''):'Your account’s uses are ready on this device.';
    emit();void flush();
  }
  function continueAfterSignin() {
    if(mergePending)return;
    const action=pendingAction;pendingAction=null;welcome='';account();hooks.closeAccount();
    if(action)hooks.replay(action);
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
    updateCatalog(window.DealsCatalog.current.data.offers);
    hooks = callbacks;const indicator=document.createElement('button');indicator.type='button';indicator.onclick=showAccount;indicator.id='header-sync';indicator.className='header-sync text-button';indicator.hidden=true;$('about-button').after(indicator);localUsage = read(localKey);
    if (!configured) rows = {...localUsage};
    authMode=knownEmail()?'signin':'create';$('signin-email').value=knownEmail();
    $('signin-form').onsubmit=sendCode;$('code-form').onsubmit=verifyCode;
    $('signin-code').oninput=()=>{paintCode();authError('');if($('signin-code').value.length===6)void verifyCode();};
    $('signin-code').onpaste=event=>{
      const digits=event.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);
      if(digits){event.preventDefault();$('signin-code').value=digits;paintCode();authError('');if(digits.length===6)void verifyCode();}
    };
    $('auth-signin').onclick=()=>chooseMode('signin');$('auth-create').onclick=()=>chooseMode('create');
    $('unknown-create').onclick=()=>{chooseMode('create');void sendCode();};
    $('auth-continue').onclick=continueAfterSignin;
    $('signin-open').onclick=openSignin;
    $('not-you').onclick=()=>{remove('deals-known-email');$('signin-email').value='';renderAuth();$('signin-email').focus();};
    $('different-email').onclick=()=>{chooseMode(authMode);$('signin-code').value='';paintCode();$('signin-email').focus();};
    $('resend').onclick=sendCode;
    const install=document.createElement('div');install.className='install-row';install.innerHTML='<button class="summary-row" aria-expanded="false">Add to Home Screen <svg viewBox="0 0 24 24" aria-hidden="true" class="install-chevron icon icon-chevron-right"> <path d="M9 6l6 6l-6 6" /></svg></button><p hidden>On iPhone, use Safari’s Share menu, then Add to Home Screen. You’ll sign in once inside the app. On a laptop, use your browser’s install button.</p>';install.querySelector('button').onclick=()=>{const button=install.querySelector('button'),open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));install.querySelector('p').hidden=!open;};
    install.hidden=matchMedia('(display-mode:standalone)').matches||navigator.standalone===true;document.querySelector('.about-lines').after(install);
    if(!install.hidden&&/iPhone|iPad|iPod/.test(navigator.userAgent)&&/Safari/.test(navigator.userAgent)&&!read('deals-install-dismissed',false)){const hint=document.createElement('div');hint.className='install-hint';hint.append(document.createTextNode('Add to Home Screen from Share for offline use'));const close=document.createElement('button');close.className='text-button';close.textContent='Dismiss';close.onclick=()=>{store('deals-install-dismissed',true);hint.remove();};hint.append(close);$('results').before(hint);}

    $('merge-keep').onclick = () => void mergeLocal(true);
    $('merge-skip').onclick = () => void mergeLocal(false);
    $('sync-retry').onclick = () => {clearTimeout(syncRetryTimer);retryDelay=15000; problem = ''; if (!client || !user) void connect(); else void refresh().then(flush); };
    $('signout').onclick = async () => {
      $('signout').disabled = true;signOutBusy=true;
      try {
        const {error} = await client.auth.signOut({scope: 'local'});
        if (error) throw error;
        remove('deals-known-email');remove('deals-auth-attempt');authAttempt=null;authStep='email';signinRequested=false;$('signin-email').value='';
        await sessionChanged(null);hooks.toast('Signed out. Your uses stay in your account.');
      } catch { problem = 'Couldn’t sign out. Please try again.'; account(); }
      finally { signOutBusy=false;$('signout').disabled = false;account(); }
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
  return {init, updateCatalog, save, saveSettings, canWrite, account,notice:id=>remoteNotices.get(id),clearNotice:id=>remoteNotices.delete(id)};
})();
