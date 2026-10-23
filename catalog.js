/* Public catalog only. Account/usage data never enters this IndexedDB database. */
window.DealsCatalog = (() => {
  'use strict';
  const config = window.DEALS_CONFIG || {};
  const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const source = configured ? config.supabaseUrl : 'local-snapshot';
  const sdkURL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  let current, listener, clientPromise, refreshPromise, resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const dbPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open('deals-catalog-v2', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('catalogs', {keyPath: 'version'});
        request.result.createObjectStore('latest');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  /** Validate before caching so a bad response cannot evict the last good catalog. */
  function map(raw) {
    if (raw?.schema_version !== 2 || typeof raw.version !== 'string' || !raw.version ||
        !raw.card?.name || !/^\d{4}-\d{2}-\d{2}$/.test(raw.card.expires_on) ||
        !['offers','locations','businesses','values'].every(key => Array.isArray(raw[key])))
      throw new Error('Unsupported catalog');
    const businesses = new Map(raw.businesses.map(b => [b.id, b]));
    const locations = new Map(), geo = {};
    for (const l of raw.locations) {
      const branch = {city:l.city, address:l.address, mapsUrl:l.maps_url, placeStatus:l.place_status,
        caution:l.caution, branchId:l.branch_id, lat:l.lat, lng:l.lng};
      if (!locations.has(l.offer_id)) locations.set(l.offer_id, []);
      locations.get(l.offer_id).push(branch);
      if (l.maps_url && Number.isFinite(l.lat) && Number.isFinite(l.lng)) geo[l.maps_url] = {lat:l.lat,lng:l.lng};
    }
    const offers = raw.offers.map(o => {
      if (!businesses.has(o.business_id) || typeof o.offer_text !== 'string' ||
          !(o.use_limit === null || Number.isInteger(o.use_limit) && o.use_limit >= 0)) throw new Error('Invalid offer');
      return {id:o.id, business:businesses.get(o.business_id).name, businessId:o.business_id,
        printedBusiness:o.printed_business, category:o.category, offer:o.offer_text, limit:o.use_limit,
        cardScope:o.card_scope, broadScope:o.broad_scope, broadCities:o.broad_cities,
        locations:locations.get(o.id)||[]};
    });
    const values = Object.fromEntries(raw.values.map(v => [v.offer_id, {id:v.offer_id,
      dealType:v.deal_type, whatYouGet:v.what_you_get, estValueUSD:v.est_value_usd,
      outOfPocketUSD:v.out_of_pocket_usd, priceLevel:v.price_level, requiresPurchase:v.requires_purchase,
      dateIdea:v.date_idea, dateIdeaWhy:v.date_idea_why, verified:v.verified, priceSource:v.price_source}]));
    // Category order is presentation, never a second source of offer data.
    const order = ['Free Stuff','Pizza','Restaurants','Entertainment','Retail, Auto, Health & Beauty','Treats & Drinks','Sandwiches & Burgers'];
    const categories = [...new Set(offers.map(o => o.category))];
    return {version:raw.version, cuisineRegions:raw.cuisine_regions||[], data:{cities:(raw.cities||[]).filter(c=>typeof c.name==='string'&&Number.isFinite(c.lat)&&Math.abs(c.lat)<=90&&Number.isFinite(c.lng)&&Math.abs(c.lng)<=180),card:{name:raw.card.name,expires:raw.card.expires_on}, offers,
      categoryOrder:[...order.filter(c => categories.includes(c)),...categories.filter(c => !order.includes(c))], places:raw.places||[]},
      cuisines:raw.businesses.map(b => ({business:b.name,isFood:b.is_food,originPrimary:b.origin_primary??null,originSecondary:b.origin_secondary??null,foodTypes:b.food_types||[],cuisines:[b.origin_primary,...(b.food_types||[])].filter(Boolean),kind:b.kind})), values, geo};
  }
  async function cached() {
    const db = await dbPromise;
    if (!db) return null;
    return new Promise(resolve => {
      const tx = db.transaction(['catalogs','latest']);
      const pointer = tx.objectStore('latest').get(source);
      pointer.onsuccess = () => {
        if (!pointer.result) return resolve(null);
        const request = tx.objectStore('catalogs').get(pointer.result);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      };
      pointer.onerror = tx.onabort = () => resolve(null);
    });
  }
  async function cache(raw) {
    const db = await dbPromise;
    if (!db) return;
    await new Promise(resolve => {
      const tx = db.transaction(['catalogs','latest'], 'readwrite');
      tx.objectStore('catalogs').put(raw);
      tx.objectStore('latest').put(raw.version, source);
      tx.oncomplete = tx.onerror = tx.onabort = resolve;
    });
  }
  /** Share a single SDK client with auth; this RPC is public and read-only. */
  function getClient() {
    if (!clientPromise) clientPromise = (async () => {
      if (!window.supabase) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = sdkURL;
        const timer = setTimeout(() => {script.remove(); reject(new Error('SDK timed out'));}, 10000);
        script.onload = () => {clearTimeout(timer); resolve();};
        script.onerror = () => {clearTimeout(timer); script.remove(); reject(new Error('SDK unavailable'));};
        document.head.append(script);
      });
      return window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
      });
    })().catch(error => {clientPromise = null; throw error;});
    return clientPromise;
  }
  function accept(raw) {
    const mapped = map(raw);
    if (current?.version === mapped.version) return;
    current = mapped;
    if (listener) listener(mapped);
    else resolveReady(mapped);
  }
  function state(failed = false) {
    const title = document.getElementById('catalog-title'), help = document.getElementById('catalog-help');
    if (!title || current) return;
    title.textContent = failed ? 'Your deals aren’t available yet' : 'Loading your deals';
    help.textContent = failed ? 'Connect to the internet, then try again. Once loaded, your deals will be available offline.' : 'Getting the latest offers for your card.';
    document.getElementById('catalog-retry').hidden = !failed;
    document.getElementById('catalog-loading').setAttribute('aria-busy', String(!failed));
  }
  function refresh() {
    if (refreshPromise) return refreshPromise;
    state();
    refreshPromise = (async () => {
      try {
        let raw;
        if (configured) {
          const client = await getClient();
          const {data, error} = await client.rpc('catalog').abortSignal(AbortSignal.timeout(12000));
          if (error) throw error;
          raw = data;
        } else {
          const response = await fetch('./catalog.snapshot.json', {cache:'no-store',signal:AbortSignal.timeout(12000)});
          if (!response.ok) throw new Error('Catalog unavailable');
          raw = await response.json();
        }
        accept(raw);
        await cache(raw);
      } catch { state(true); }
      finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  document.getElementById('catalog-retry').onclick = refresh;
  addEventListener('online', () => void refresh());
  // The shell must become installable even if the first catalog request fails.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  void (async () => {
    try { const raw = await cached(); if (raw) accept(raw); } catch {}
    void refresh();
  })();
  return {ready, getClient, refresh, map, subscribe(callback) {
    listener = callback;
    // Replay the current version to cover a refresh between ready and subscription.
    if (current) callback(current);
  }, get current() {return current;}};
})();
