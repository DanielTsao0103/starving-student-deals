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
  let authMode='signin', authStep='email', authAttempt=null, verifyBusy=false, resendAt=0;
  let welcome='', onboarding=false, newAccount=false, mergePending=false, mergeReceipt=null;
  let signOutBusy=false, deleteConfirm=false, deleteBusy=false, retryNotBefore=0, retryReason='';
  const deletedAccounts=new Set();
  let invites;
  const offers=new Map();
  const setText=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
  const plural=(count,word)=>count+' '+word+(count===1?'':'s');
  let syncRetryTimer, authSubscription, localUsage = {}, signInBusy = false;
  const inFlight = new Map(), remoteNotices=new Map(), collisions=new Set();
  const limits=new Map();
  function updateCatalog(items) {offers.clear();limits.clear();for(const o of items){offers.set(o.id,o);limits.set(o.id,o.limit);}}
  const clamp=(id,n)=>Math.min(limits.get(id)??2147483647,Math.max(0,n));
  function optimistic(id,item){return {used:clamp(id,(rows[id]?.used||0)+(item.deltas||[]).reduce((sum,d)=>sum+d.delta,0)),note:item.notes?.at(-1)?.note??item.note??rows[id]?.note??''};}
  const clean = row => ({used: Math.max(0, Number.isSafeInteger(row?.used) ? row.used : 0), note: String(row?.note || '').slice(0, 500)});
  function read(key, fallback = {}) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); memoryOnly=false;hooks?.saveFailure?.(false);return true; }
    catch { memoryOnly = true;hooks?.saveFailure?.(true);return false; }
  }
  function accountKey(id = user?.id) { return 'deals-web-account-v1:' + id; }
  function persist() { return user ? store(accountKey(), {rows, outbox, mergeReceipt, retryNotBefore, retryReason}) : false; }
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
    setText('merge-keep',newAccount?'Add':'Keep both');setText('merge-skip',"Don't add this device's uses");
    const list=$('merge-differences');list.replaceChildren();
    for(const item of changes){
      const li=document.createElement('li'),title=document.createElement('strong'),detail=document.createElement('span');
      title.textContent=offers.get(item.id).business;
      const count=document.createElement('span');count.className='merge-count';count.textContent=item.delta?'+'+item.delta:'';title.append(count);
      detail.textContent=offers.get(item.id).offer;
      li.append(title,detail);if(item.note){const note=document.createElement('span');note.className='quiet';note.textContent=item.note;li.append(note);}list.append(li);
    }
  }
  function renderAuth() {
    const busy=signInBusy||verifyBusy;
    $('signin-form').hidden=authStep!=='email';$('signin-sent').hidden=authStep!=='code';
    $('signin-title').hidden=authStep==='code';$('signin-intro').hidden=authStep==='code';
    setText('signin-intro',pendingAction?.kind==='use'?"Sign in to save this use. It's added as soon as you're in.":'Use your invited email. Each person has a separate card.');
    setText('signin-title','Sign in');
    setText('signin-submit',signInBusy?'Sending…':'Email me a code');
    $('signin-submit').disabled=initializing||busy;
    $('signin-email').readOnly=busy;$('signin-code').readOnly=busy;
    $('code-submit').disabled=busy;setText('code-submit',verifyBusy?'Verifying…':'Verify code');
    $('different-email').disabled=busy;
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
    authError('');renderAuth();
  }
  function openSignin() {
    signinRequested=true;welcome='';authMode='signin';
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
    const authenticating=signinRequested&&!user,focused=authenticating||mergePending||Boolean(welcome)||deleteConfirm||Boolean(catchupStep)||Boolean(invites?.isOpen());
    invites?.visibility(focused);
    // Keep AUTH.md's complete new-account receipt in the live status below.
    // A neutral sheet title avoids announcing the same greeting twice.
    setText('about-title',authenticating&&authStep==='code'?'Check your email':welcome?(newAccount?'Your card':'Welcome back'):focused?'Account':'Your card');$('about-title').hidden=false;
    $('about-sheet').classList.toggle('account-focused',focused);
    document.querySelector('.about-usage').hidden=true;
    $('account-title').hidden=focused;$('account-status').hidden=focused;
    $('account-privacy').hidden=focused;
    $('signin-open').hidden=Boolean(user)||signinRequested||!configured;
    setText('account-privacy','We store your email, uses, notes and settings, never your location coordinates. '+(user?'Delete them with Delete my account and data below.':'Delete them with Delete my account and data when signed in.'));
    const count = Object.values(outbox).reduce((sum,item)=>sum+(item.deltas?.length||0)+(item.notes?.length||0),0);
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
    $('account-email').hidden = !user||Boolean(catchupStep);
    setText('account-email',user?.email||'');
    $('signout').hidden = !user||focused;
    $('delete-open').hidden=!user||focused;
    $('delete-panel').hidden=!deleteConfirm;
    $('delete-confirm').disabled=deleteBusy;$('delete-cancel').disabled=deleteBusy;
    setText('delete-confirm',deleteBusy?'Deleting…':'Delete permanently');
    $('catchup-open').hidden=!user||focused;
    $('catchup-panel').hidden=!catchupStep;
    $('signin-panel').hidden = !signinRequested || Boolean(user);
    $('signout-help').hidden=true;renderAuth();
    $('auth-success').hidden=!welcome||mergePending||Boolean(catchupStep);setText('auth-welcome',welcome);if(welcome)$('auth-welcome').after($('account-email'));else $('account-status').after($('account-email'));
    $('sync-retry').hidden = !configured || !problem;
    $('merge-panel').hidden=!user||!mergePending;
  }
  function showAccount() { hooks.showAccount(); account(); requestAnimationFrame(()=>document.querySelector('.account')?.scrollIntoView({block:'start'})); }
  function canWrite(action=null) {
    if (!configured || (user && !initializing && !loadingUsage && !mergePending && !onboarding && !signOutBusy)) return true;
    pendingAction=action;if(!user)openSignin();showAccount();
    return false;
  }
  async function save(id, next, source='app') {
    if (!offers.has(id)||!canWrite({kind:'note',id,note:next.note})) return false;
    source=source==='normal'?'app':source;
    if(!['app','catch-up','merge'].includes(source))return false;
    next = clean(next);
    if (!configured) {
      rows[id] = next; localUsage = {...rows}; store(localKey, rows); emit(); return true;
    }
    // Persist before acknowledging the optimistic update. The queue survives reloads.
    const current=outbox[id]?optimistic(id,outbox[id]):clean(rows[id]);
    const delta=clamp(id,next.used)-current.used,item=outbox[id]||{deltas:[],notes:[]};
    queueDelta(item,delta,source);
    if(next.note!==current.note)item.notes.push({note:next.note,token:crypto.randomUUID()});
    outbox[id]=item;
    persist(); emit(); void flush(); return true;
  }
  /** Split large batches before persisting; each immutable payload has its own receipt. */
  function queueDelta(item,delta,source) {
    while(delta){const part=Math.sign(delta)*Math.min(1000,Math.abs(delta));item.deltas.push({delta:part,source,token:crypto.randomUUID()});delta-=part;}
  }
  async function flush() {
    if (!user || !client || initializing || loadingUsage || flushing || signOutBusy || !navigator.onLine) return;
    clearTimeout(syncRetryTimer);
    if(Date.now()<retryNotBefore){syncRetryTimer=setTimeout(()=>void flush(),retryNotBefore-Date.now());return;}
    flushing = true;
    const generation = epoch;
    let active;
    try {
      while (generation === epoch && navigator.onLine && !signOutBusy) {
        const entry=Object.entries(outbox).find(([,item])=>!item.blocked);
        if(!entry)break;
        const [id,item]=entry;
        const count=item.deltas[0],note=item.notes[0];
        if(!count&&!note){delete outbox[id];persist();continue;}
        // Capture both ID and payload before await. Edits append a new operation.
        const action={...(count||note)},expected=clamp(id,(rows[id]?.used||0)+(count?.delta||0));
        active=item;
        inFlight.set(id,{used:expected,note:count?rows[id]?.note||'':action.note});
        const result=count
          ? await client.rpc('bump_usage',{p_offer_id:id,p_delta:action.delta,p_op_id:action.token,p_source:action.source==='normal'?'app':action.source||'app'})
          : await client.rpc('set_usage_note',{p_offer_id:id,p_note:action.note,p_op_id:action.token});
        if(generation!==epoch)return;
        inFlight.delete(id);
        if(result.error)throw result.error;
        const data=Array.isArray(result.data)?result.data[0]:result.data;
        if(!data)throw new Error('Missing usage receipt');
        if(count&&data.used!==expected)collisions.add(id);
        const previous=rows[id];
        if(!previous?.updated_at||!data.updated_at||data.updated_at>=previous.updated_at)rows[id]={...clean(data),updated_at:data.updated_at};
        const queued=outbox[id];
        if(count)queued.deltas=queued.deltas.filter(d=>d.token!==action.token);
        else queued.notes=queued.notes.filter(n=>n.token!==action.token);
        if(!queued.deltas.length&&!queued.notes.length){delete outbox[id];if(collisions.has(id)){remoteNotices.set(id,'Updated');collisions.delete(id);}}
        problem = '';lastSynced=Date.now();retryDelay=15000;retryNotBefore=0; persist(); emit();if($('detail').dataset.offerId===id)void showHistory(id);
      }
      if(Object.values(outbox).some(item=>item.blocked))problem='A change could not sync. Your device copy is kept. Contact Dan for help.';
    } catch(error) {
      if (generation === epoch) {
        const permanent=['22023','23503','42501'].includes(error.code);
        if(permanent){active.blocked=error.code;problem='A change could not sync. Your device copy is kept. Contact Dan for help.';}
        else {
          problem='Changes saved on this device. Sync will retry.';
          const delay=error.code==='P0001'?60000+Math.random()*10000:retryDelay;
          retryReason=error.code||'';retryNotBefore=Date.now()+delay;
          syncRetryTimer=setTimeout(()=>void flush(),delay);retryDelay=Math.min(60000,retryDelay*2);
        }
        persist();
      }
    } finally {
      if (generation === epoch) { flushing = false; account(); }
    }
  }
  async function refresh(generation = epoch) {
    if (!user || signOutBusy || !navigator.onLine) return;
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
    const nextUser = deletedAccounts.has(session?.user?.id)?null:session?.user||null;
    if (!initializing && nextUser?.id === user?.id) { account(); void flush(); void refreshSettings(); return; }
    const previousUser=user;
    const generation = ++epoch;
    if(previousUser && previousUser.id!==nextUser?.id){
      catchupStep='';catchupCounts={};deleteConfirm=false;
      remove(accountKey(previousUser.id));remove('deals-web-settings-v1:'+previousUser.id);
      localUsage={};remove(localKey);welcome='';mergePending=false;onboarding=false;pendingAction=null;
      remoteNotices.clear();collisions.clear();
    }
    clearTimeout(syncRetryTimer);clearTimeout(settingsRetryTimer);hooks.onReset();
    if (channel) { void client.removeChannel(channel); channel = null; }
    user = nextUser; void invites?.session(client, user); settingsFlushing=false;settingsReady=false;const settingsCache=user?read(settingsKey()):{};settings=settingsCache.settings||{};settingsPending=settingsCache.pending||{};hooks.onSettings(user?{...settings,...settingsPending}:null);flushing = false; inFlight.clear(); live = false; problem = '';
    const cached = user ? read(accountKey()) : {};
    rows = cached.rows || {}; outbox = cached.outbox || {};mergeReceipt=cached.mergeReceipt||null;retryNotBefore=cached.retryNotBefore||0;retryReason=cached.retryReason||'';
    if(user){
      authAttempt ||= read('deals-auth-attempt',null);
      onboarding=Boolean(authAttempt?.email===user.email)||differences().length>0;
      if(mergeReceipt===localFingerprint()){localUsage={};remove(localKey);}
      rememberEmail(user.email);signinRequested=false;
    }else{authMode='signin';$('signin-email').value=knownEmail();}
    loadingUsage = Boolean(user && navigator.onLine);
    for(const [id,item] of Object.entries(outbox)){
      if(!item.deltas){item.deltas=[];queueDelta(item,(item.used||0)-(rows[id]?.used||0),'app');delete item.used;}
      item.notes ||= item.note===undefined?[]:[{note:item.note,token:item.token||crypto.randomUUID()}];
      delete item.note;delete item.token;
      // Do not regenerate IDs when upgrading a persisted offline operation.
      for(const action of item.deltas)action.source=action.source==='normal'?'app':action.source||'app';
    }
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
    signInBusy=true;authError('');renderAuth();
    try {
      if(!client)await connect();
      if(!client)throw new Error('Unavailable');
      const {error}=await client.auth.signInWithOtp({email,options:{shouldCreateUser:false,
        emailRedirectTo:location.origin+location.pathname}});
      if(error)throw error;
      authAttempt={email,mode:authMode,startedAt,sentAt:Date.now()};store('deals-auth-attempt',authAttempt);
      authStep='code';$('signin-code').value='';paintCode();
      setText('sent-message','Enter the 6-digit code sent to '+email);
      cooldown();renderAuth();$('signin-code').focus({preventScroll:true});
    }catch(error){
      if(authMode==='signin'&&(error.code==='otp_disabled'||error.code==='user_not_found'||/signups? (?:not allowed|disabled)|user not found/i.test(error.message||''))){
        // An uninvited address is an account notice, not a failed code entry.
        authError('');
        setText('signin-status','This app is invite-only. Ask Dan to add '+email+'.');
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
      $('signin-code').focus({preventScroll:true});$('signin-code').select();
    }finally{verifyBusy=false;account();}
  }
  function finishSignin() {
    if(!user||loadingUsage)return;
    onboarding=false;
    newAccount=!Object.values(rows).some(row=>row.used>0||row.note)||Boolean(user.last_sign_in_at&&Math.abs(Date.parse(user.created_at)-Date.parse(user.last_sign_in_at))<1000);
    const hasAttempt=Boolean(authAttempt);
    mergePending=differences().length>0;
    const used=Object.values(rows).reduce((n,row)=>n+row.used,0),deals=Object.values(rows).filter(row=>row.used>0).length;
    welcome=newAccount?"You're all set. Uses you mark now sync to your other devices.":
      'Welcome back. Your card is synced: '+plural(used,'use')+' on '+plural(deals,'deal')+'.';
    authAttempt=null;remove('deals-auth-attempt');authStep='email';$('signin-code').value='';paintCode();
    clearInterval(resendTimer);resendAt=0;
    if(mergePending)renderMerge();else applyPendingUse();
    if(hasAttempt||mergePending){showAccount();$('about-title').focus({preventScroll:true});}else{welcome='';account();}
  }
  /** Commit receipt + outbox together before consuming the anonymous device cache. */
  async function mergeLocal(keep) {
    if(!user||!mergePending)return;
    const fingerprint=localFingerprint(),added=keep?differences().reduce((sum,item)=>sum+item.delta,0):0;
    if(keep&&mergeReceipt!==fingerprint){
      for(const item of differences()){
        const queued=outbox[item.id]||{deltas:[],notes:[]};
        queueDelta(queued,item.delta,'merge');
        if(item.note)queued.notes.push({note:[...new Set([item.remote.note,item.note].filter(Boolean))].join('\n').slice(0,500),token:crypto.randomUUID()});
        outbox[item.id]=queued;
      }
    }
    mergeReceipt=fingerprint;persist();localUsage={};remove(localKey);mergePending=false;
    const current=[...offers.keys()].map(currentUsage),uses=current.reduce((sum,row)=>sum+row.used,0),deals=current.filter(row=>row.used>0).length;
    welcome=keep?'Added '+added+' uses from this device. Your card now has '+uses+' uses on '+deals+' deals.':'Your account’s uses are ready on this device.';
    applyPendingUse();
    emit();void flush();
  }
  function applyPendingUse(){
    if(pendingAction?.kind!=='use'||mergePending)return;
    const action=pendingAction,offer=offers.get(action.id);if(!offer)return;
    const before=currentUsage(action.id);if(offer.limit!==null&&before.used>=offer.limit)return;
    pendingAction=null;
    void save(action.id,{...before,used:before.used+1});
    welcome+='\nMarked used: '+offer.business+'.';
  }
  function continueAfterSignin() {
    if(mergePending)return;
    if(newAccount){newAccount=false;welcome='';openCatchup('ask');return;}
    const action=pendingAction;pendingAction=null;welcome='';account();hooks.closeAccount();
    if(action)hooks.replay(action);
  }
  let catchupStep='',catchupCounts={},catchupUndo=null;
  const catchupLocks=new Map();
  function currentUsage(id){return outbox[id]?optimistic(id,outbox[id]):clean(rows[id]);}
  function openCatchup(step='pick') {
    catchupStep=step;catchupCounts={};catchupUndo=null;
    $('catchup-search').value='';renderCatchup();account();
    (step==='pick'?$('catchup-search'):$('catchup-title')).focus({preventScroll:true});
  }
  function finishCatchup(){catchupStep='';catchupCounts={};catchupUndo=null;continueAfterSignin();}
  function beforeCloseAccount(){
    if(deleteBusy)return true;
    if(catchupStep){finishCatchup();return true;}
    deleteConfirm=false;return false;
  }
  function catchupMatches(){
    const normalize=text=>text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,'');
    const queries=$('catchup-search').value.split(/[,\n]/).map(normalize).filter(Boolean);
    return [...offers.values()].filter(o=>!['H037','F029'].includes(o.id)&&(!queries.length||queries.some(q=>normalize(o.business+' '+o.offer).includes(q))))
      .sort((a,b)=>a.business.localeCompare(b.business));
  }
  function renderCatchup(){
    $('catchup-ask').hidden=catchupStep!=='ask';$('catchup-picker').hidden=catchupStep!=='pick';
    setText('catchup-title',catchupStep==='ask'?'Already used some deals on your card?':'Catch up my card');
    const list=$('catchup-results');list.replaceChildren();
    if(catchupStep!=='pick')return;
    for(const offer of catchupMatches()){
      const row=document.createElement('div'),button=document.createElement('button'),title=document.createElement('strong'),detail=document.createElement('span'),count=document.createElement('input');
      row.className='catchup-row';button.className='catchup-add';button.dataset.offerId=offer.id;
      title.textContent=offer.business;detail.textContent=offer.offer;button.append(title,detail);
      const used=currentUsage(offer.id).used;
      button.disabled=used>= (offer.limit??2147483647);button.onclick=()=>changeCatchup(offer.id,used+1);
      count.className='catchup-count';count.type='number';count.min='0';count.max=String(offer.limit??2147483647);count.value=String(used);count.setAttribute('aria-label','Uses for '+offer.business+': '+offer.offer);
      count.onchange=()=>changeCatchup(offer.id,Number(count.value),false);
      row.append(button,count);list.append(row);
    }
    if(!list.children.length){const empty=document.createElement('p');empty.className='quiet';empty.textContent='No deals found. Try a business name.';list.append(empty);}
    const counts=Object.values(catchupCounts).filter(n=>n!==0);
    setText('catchup-total',plural(counts.reduce((a,b)=>a+b,0),'use')+' on '+plural(counts.length,'deal'));
    $('catchup-undo').hidden=!catchupUndo;
  }
  function changeCatchup(id,value,debounce=true){
    if(!Number.isSafeInteger(value)||debounce&&Date.now()<(catchupLocks.get(id)||0))return;
    catchupLocks.set(id,Date.now()+400);
    const before=currentUsage(id),used=clamp(id,value),delta=used-before.used;
    if(!delta)return;
    catchupUndo={id,before:before.used,delta};catchupCounts[id]=(catchupCounts[id]||0)+delta;
    void save(id,{...before,used},'catch-up');renderCatchup();
  }
  async function showHistory(id){
    const el=$('usage-history');if(!el)return;el.hidden=true;el.textContent='';
    if(!user||!client||signOutBusy||!navigator.onLine)return;
    const generation=epoch,owner=user.id;
    try {
      const {data,error}=await client.from('usage_ops').select('op_id,offer_id,delta,source,kind,created_at').eq('user_id',owner).eq('offer_id',id).neq('kind','note').order('created_at',{ascending:false}).limit(50);
      if(error||generation!==epoch||$('detail').dataset.offerId!==id)return;
      const events=(data||[]).filter(event=>event.kind!=='note'&&event.delta!==0);
      const labels=[];
      if(events.some(event=>event.source==='catch-up'))labels.push('Added during catch-up');
      if(events.some(event=>event.source==='merge'))labels.push('Added from this device');
      el.textContent=labels.join('. ');el.hidden=!labels.length;
    }catch { /* Usage stays available when optional history is offline. */ }
  }
  /** Account deletion is the only operation allowed while sync is suspended. */
  async function deleteAccount(){
    if(!user||!deleteConfirm||deleteBusy)return;
    deleteBusy=true;signOutBusy=true;const owner=user.id;
    clearTimeout(syncRetryTimer);clearTimeout(settingsRetryTimer);
    setText('delete-status','');account();
    try {
      const {error}=await client.rpc('delete_my_account');
      if(error)throw error;
    }catch {
      deleteBusy=false;signOutBusy=false;setText('delete-status','Couldn’t delete your account. Nothing was cleared here. Try again.');account();void flush();void flushSettings();return;
    }
    // Once deletion succeeds, late responses and auth callbacks cannot restore this account.
    deletedAccounts.add(owner);
    for(const key of [accountKey(owner),'deals-web-settings-v1:'+owner,localKey,'deals-known-email','deals-auth-attempt',
      'deals-location-v1','starving-student-2027-filters','recentCities','cityChosenOnce'])remove(key);
    authAttempt=null;authStep='email';signinRequested=false;pendingAction=null;welcome='';localUsage={};
    clearInterval(resendTimer);resendAt=0;$('signin-email').value='';$('signin-code').value='';paintCode();
    await sessionChanged(null);hooks.onForgetDevice?.();
    try {await client.auth.signOut({scope:'local'});}catch { /* Remote account is already deleted. */ }
    // The SDK can fail to remove a stale JWT when offline; also clear its own storage key.
    const key='sb-'+new URL(config.supabaseUrl).hostname.split('.')[0]+'-auth-token';
    remove(key);remove(key+'-code-verifier');remove(key+'-user');
    deleteBusy=false;signOutBusy=false;deleteConfirm=false;account();hooks.toast('Your account and data were deleted.');
  }
  // Settings use a separate, account-scoped outbox; coordinates are never accepted.
  let settings = {}, settingsPending = {}, settingsFlushing = false, settingsReady = false;
  let settingsRetryTimer;
  function settingsKey() { return 'deals-web-settings-v1:' + user?.id; }
  function persistSettings() { if(user)store(settingsKey(), {settings, pending:settingsPending}); }
  function saveSettings(patch) {
    if(!user||signOutBusy)return;
    if(typeof patch.home_city==='string'&&patch.home_city.length>100)return;
    if(patch.location_opt_in === true)settingsPending.location_opt_in=true;
    if(Object.hasOwn(patch,'home_city'))settingsPending.home_city=typeof patch.home_city==='string'?patch.home_city:null;
    persistSettings();void flushSettings();
  }
  async function refreshSettings(generation=epoch) {
    if(!user||!client||signOutBusy||!navigator.onLine)return;
    const owner=user.id;
    try {
      const {data,error}=await client.from('user_settings').select('location_opt_in,home_city,updated_at').eq('user_id',owner).maybeSingle();
      if(generation!==epoch)return;
      if(error)throw error;
      settings=data||{};settingsReady=true;
      const device=hooks.getLocationSettings();
      if(device.location_opt_in&&!settings.location_opt_in)settingsPending.location_opt_in=true;
      // A saved city on a new account can seed its preference, but never overwrite a remote choice on load.
      if(!settings.home_city&&device.home_city&&device.home_city.length<=100&&!Object.hasOwn(settingsPending,'home_city'))settingsPending.home_city=device.home_city;
      persistSettings();hooks.onSettings({...settings,...settingsPending});void flushSettings();
    }catch {
      if(generation===epoch){
        // Migration may not be deployed yet; device location remains fully usable.
        clearTimeout(settingsRetryTimer);settingsRetryTimer=setTimeout(()=>void refreshSettings(generation),30000);
      }
    }
  }
  async function flushSettings() {
    if(!user||!client||signOutBusy||!settingsReady||settingsFlushing||!navigator.onLine||!Object.keys(settingsPending).length)return;
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
    invites ||= window.createDealsInvites(account);
    authMode='signin';$('signin-email').value=knownEmail();
    $('signin-form').onsubmit=sendCode;$('code-form').onsubmit=verifyCode;
    $('signin-email').oninput=()=>authError('');
    $('signin-code').oninput=()=>{paintCode();authError('');if($('signin-code').value.length===6)void verifyCode();};
    $('signin-code').onpaste=event=>{
      const digits=event.clipboardData.getData('text').replace(/\D/g,'').slice(0,6);
      if(digits){event.preventDefault();$('signin-code').value=digits;paintCode();authError('');if(digits.length===6)void verifyCode();}
    };
    $('auth-continue').onclick=continueAfterSignin;
    $('catchup-open').onclick=()=>openCatchup();
    $('catchup-pick').onclick=()=>openCatchup();
    $('catchup-skip').onclick=finishCatchup;$('catchup-done').onclick=finishCatchup;
    $('catchup-search').oninput=renderCatchup;
    $('catchup-search').onkeydown=event=>{if(event.key==='Enter'){const matches=catchupMatches();if(new Set(matches.map(o=>o.business)).size===1){event.preventDefault();const o=matches.find(o=>currentUsage(o.id).used<(o.limit??2147483647));if(o)changeCatchup(o.id,currentUsage(o.id).used+1);$('catchup-search').value='';renderCatchup();}}};
    $('catchup-undo').onclick=()=>{if(!catchupUndo)return;const {id,delta}=catchupUndo;catchupCounts[id]-=delta;void save(id,{...currentUsage(id),used:Math.max(0,currentUsage(id).used-delta)},'catch-up');catchupUndo=null;renderCatchup();};
    $('delete-open').onclick=()=>{deleteConfirm=true;setText('delete-status','');account();$('delete-title').focus({preventScroll:true});};
    $('delete-cancel').onclick=()=>{deleteConfirm=false;account();$('delete-open').focus({preventScroll:true});};
    $('delete-confirm').onclick=deleteAccount;
    $('signin-open').onclick=openSignin;
    $('not-you').onclick=()=>{remove('deals-known-email');$('signin-email').value='';renderAuth();$('signin-email').focus({preventScroll:true});};
    $('different-email').onclick=()=>{chooseMode(authMode);$('signin-code').value='';paintCode();$('signin-email').focus({preventScroll:true});};
    $('resend').onclick=sendCode;
    const install=document.createElement('div');install.className='install-row';install.innerHTML='<button class="summary-row" aria-expanded="false">Add to Home Screen <svg viewBox="0 0 24 24" aria-hidden="true" class="install-chevron icon icon-chevron-right"> <path d="M9 6l6 6l-6 6" /></svg></button><p hidden>On iPhone, use Safari’s Share menu, then Add to Home Screen. You’ll sign in once inside the app. On a laptop, use your browser’s install button.</p>';install.querySelector('button').onclick=()=>{const button=install.querySelector('button'),open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));install.querySelector('p').hidden=!open;};
    install.hidden=matchMedia('(display-mode:standalone)').matches||navigator.standalone===true;document.querySelector('.about-lines').after(install);
    if(!install.hidden&&/iPhone|iPad|iPod/.test(navigator.userAgent)&&/Safari/.test(navigator.userAgent)&&!read('deals-install-dismissed',false)){const hint=document.createElement('div');hint.className='install-hint';hint.append(document.createTextNode('Add to Home Screen from Share for offline use'));const close=document.createElement('button');close.className='text-button';close.textContent='Dismiss';close.onclick=()=>{store('deals-install-dismissed',true);hint.remove();};hint.append(close);$('results').before(hint);}

    $('merge-keep').onclick = () => void mergeLocal(true);
    $('merge-skip').onclick = () => void mergeLocal(false);
    $('sync-retry').onclick = () => {clearTimeout(syncRetryTimer);retryDelay=15000;if(retryReason!=='P0001')retryNotBefore=0; problem = ''; if (!client || !user) void connect(); else void refresh().then(flush); };
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
  return {init, updateCatalog, beforeCloseAccount, showHistory, save, saveSettings, canWrite, account,notice:id=>remoteNotices.get(id),clearNotice:id=>remoteNotices.delete(id)};
})();
