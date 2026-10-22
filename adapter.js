/* Web-only persistence. Every account gets its own cache and durable outbox. */
window.DealsWeb = (() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const config = window.DEALS_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const localKey = 'deals-web-local-v1';
  const sdkURL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  let hooks, client, user = null, channel, rows = {}, outbox = {}, epoch = 0;
  let initializing = configured, flushing = false, problem = '', memoryOnly = false, live = false;
  let syncRetryTimer, authSubscription, localUsage = {}, signInBusy = false;
  const inFlight = new Map();
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
    for (const [id, item] of Object.entries(outbox)) next[id] = clean(item);
    hooks.onUsage(next); account();
  }
  function account() {
    if (!hooks) return;
    const signInScreen = configured && !user;
    $('about-title').textContent = signInScreen ? 'Sign in' : 'Your card';
    $('account-title').hidden = signInScreen;
    $('account-status').hidden = signInScreen && !problem;
    for (const element of $('about-sheet').children) {
      if (!element.matches('.handle,.utility-head,.account')) element.hidden = signInScreen;
    }
    $('about-sync').hidden = true; // Settings already shows the same status.
    document.querySelector('.install-tip').hidden = signInScreen;
    const count = Object.keys(outbox).length;
    const message = !configured ? 'Not syncing · Saved ' + (memoryOnly ? 'for this visit' : 'on this device') :
      initializing ? 'Connecting to your account…' : !user ? (problem || 'Not syncing · Sign in to save your uses') :
      memoryOnly ? 'Device storage is full · Keep this page open until synced' :
      !navigator.onLine ? 'Offline · ' + (count ? count + ' changes waiting to sync' : 'Your saved uses are available') :
      problem || (count ? 'Syncing ' + count + ' changes…' : live ? 'Synced across your devices' : 'Saved · Connecting live sync…');
    $('account-status').textContent = message;
    $('about-sync').textContent = message;
    $('account-email').hidden = !user;
    $('account-email').textContent = user?.email || '';
    $('signout').hidden = !user;
    $('signin-panel').hidden = !configured || Boolean(user);
    $('signin-submit').disabled = initializing || signInBusy;
    $('sync-retry').hidden = !configured || !problem;
    const hasLocal = Object.values(localUsage).some(row => row.used || row.note);
    $('merge-panel').hidden = !user || !hasLocal || Boolean(read('deals-web-merge-decided', false));
  }
  function showAccount() { hooks.showAccount(); account(); }
  function canWrite() {
    if (!configured || (user && !initializing)) return true;
    showAccount();
    if (!initializing) $('signin-email').focus();
    return false;
  }
  async function save(id, next) {
    if (!canWrite()) return false;
    next = clean(next);
    if (!configured) {
      rows[id] = next; localUsage = {...rows}; store(localKey, rows); emit(); return true;
    }
    // Persist before acknowledging the optimistic update. The queue survives reloads.
    outbox[id] = {...next, token: crypto.randomUUID()};
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
        inFlight.set(id, clean(item));
        const {data, error} = await client.from('usage').upsert(
          {user_id: owner, offer_id: id, ...clean(item)}, {onConflict: 'user_id,offer_id'}
        ).select().single();
        if (generation !== epoch) return;
        inFlight.delete(id);
        if (error) throw error;
        const previous = rows[id];
        // A newer realtime event must not be replaced by a delayed HTTP response.
        if (!previous?.updated_at || !data?.updated_at || data.updated_at >= previous.updated_at)
          rows[id] = {...clean(data || item), updated_at: data?.updated_at};
        if (outbox[id]?.token === item.token) delete outbox[id];
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
      problem = ''; persist(); emit();
    } catch { if (generation === epoch) { problem = 'Couldn’t refresh your uses. Retry when connected.'; account(); } }
  }
  async function sessionChanged(session) {
    const nextUser = session?.user || null;
    if (!initializing && nextUser?.id === user?.id) { account(); void flush(); return; }
    const generation = ++epoch;
    clearTimeout(syncRetryTimer); hooks.onReset();
    if (channel) { void client.removeChannel(channel); channel = null; }
    user = nextUser; flushing = false; inFlight.clear(); live = false; problem = '';
    const cached = user ? read(accountKey()) : {};
    rows = cached.rows || {}; outbox = cached.outbox || {};
    initializing = false; emit();
    if (!user) return;
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
        if (changed && !ownEcho) {
          const notice = outbox[id] ? 'This offer changed on another device. Your queued change will sync next.' : 'Usage updated on another device.';
          hooks.status(notice); problem = notice;
        }
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
    $('signin-status').textContent = 'Sending your sign-in link…';
    $('signin-submit').textContent = 'Sending…'; account();
    try {
      if (!client) await connect();
      if (!client) throw new Error('Unavailable');
      const {error} = await client.auth.signInWithOtp({email, options: {emailRedirectTo: location.origin + location.pathname}});
      if (error) throw error;
      $('signin-status').dataset.state = 'sent';
      $('signin-status').textContent = 'Check your email at ' + email + '. Open the link to sign in.';
      $('signin-submit').textContent = 'Resend sign-in link';
    } catch {
      $('signin-status').dataset.state = 'error';
      $('signin-status').textContent = 'Couldn’t send the link. Check your connection and email, then try again.';
      $('signin-submit').textContent = 'Try again';
    } finally { signInBusy = false; account(); }
  }
  async function mergeLocal(keep) {
    if (!user) return;
    if (keep) {
      for (const [id, local] of Object.entries(localUsage)) {
        const remote = outbox[id] || rows[id] || {};
        const note = [remote.note, local.note].filter((v, i, all) => v && all.indexOf(v) === i).join('\n').slice(0, 500);
        outbox[id] = {...clean({used: Math.max(local.used || 0, remote.used || 0), note}), token: crypto.randomUUID()};
      }
      persist(); emit();
    }
    store('deals-web-merge-decided', true); account(); void flush();
  }
  function setupLocation() {
    const group = document.createElement('div'); group.className = 'location-controls';
    $('pick-area').before(group); group.append($('pick-area'));
    const button = document.createElement('button'); button.id = 'use-location'; button.className = 'text-button';
    button.textContent = 'Use my location'; group.append(button);
    const message = document.createElement('p'); message.id = 'gps-status'; message.role = 'status'; message.hidden = true;
    $('recommend-controls').after(message);
    button.onclick = () => {
      message.hidden = false;
      if (!navigator.geolocation) { message.textContent = 'Location is unavailable. Pick your area instead.'; return; }
      button.disabled = true; message.textContent = 'Finding your location…';
      navigator.geolocation.getCurrentPosition(position => {
        button.disabled = false; message.hidden = true;
        hooks.onLocation({lat: position.coords.latitude, lng: position.coords.longitude});
      }, () => {
        button.disabled = false; message.textContent = 'Location isn’t available. Pick your area instead.';
      }, {timeout: 10000, maximumAge: 60000, enableHighAccuracy: false});
    };
  }
  function init(callbacks) {
    hooks = callbacks; localUsage = read(localKey);
    if (!configured) rows = {...localUsage};
    $('signin-form').onsubmit = sendLink;
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
    setupLocation(); emit(); void connect();
    addEventListener('online', () => { account(); if (user) void refresh().then(flush); else if (configured) void connect(); });
    addEventListener('offline', account);
    addEventListener('storage', event => {
      if (!configured && event.key === localKey) { rows = read(localKey); localUsage = {...rows}; emit(); }
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {
      $('account-status').textContent = 'Offline setup unavailable. Reload when connected.';
    });
  }
  return {init, save, canWrite, account};
})();
