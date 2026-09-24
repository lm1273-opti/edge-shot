import { TOKEN, PORT } from './config.js';

const BASE = `http://127.0.0.1:${PORT}`;

// Melyik böngészőben futunk? A fül-azonosítók böngészőnként MÁSOK, ezért ha két
// böngészőbe is betöltik a bővítményt, a `--tab 42` a rossz böngésző egy létező fülét
// fotózná le — helyesnek látszó képpel. A szerver ebből veszi észre a helyzetet.
function detectBrowser() {
  const ua = navigator.userAgent;
  if (/\bEdg\//.test(ua)) return 'Edge';
  if (/\bOPR\//.test(ua)) return 'Opera';
  if (/\bBrave\//.test(ua)) return 'Brave';
  if (/\bChrome\//.test(ua)) return 'Chrome';
  return 'Chromium';
}
const BROWSER = detectBrowser();

// A név nem azonosít: az Edge és az Edge Beta (vagy két Chrome-profil) egyaránt „Edge"
// / „Chrome", így két betöltött bővítmény egynek látszott, és a `--tab` a rossz
// példányba mehetett. Ezért minden példány kap egy TARTÓS azonosítót. Tartós kell
// legyen: a service worker gyakran újraindul, és egy friss azonosító minden indulásnál
// 60 s-ig hamis „két böngésző" tiltást adna.
let HDR = { 'x-shot-token': TOKEN, 'x-browser': BROWSER };
async function instanceId() {
  try {
    const { instanceId: got } = await chrome.storage.local.get('instanceId');
    if (got) return got;
    const id = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ instanceId: id });
    return id;
  } catch { return null; }  // storage nélkül is működjön, csak névvel
}
const ready = instanceId().then((id) => {
  if (id) HDR = { ...HDR, 'x-browser': `${BROWSER}#${id}` };
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let looping = false;
let lastPollAt = 0;

// A felvétel a job-cikluson KÍVÜL él: a `recstart` job azonnal visszatér, a kockák
// eseményvezérelten érkeznek. Így a ciklus tovább pollozik, a rec-stop átjut, és
// sem a 60 s-os feladat-korlát, sem a 90 s-os őrkutya nem öli meg a felvételt.
let rec = null;

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} (${ms} ms)`)), ms)),
]);

// --- debugger protokoll segéd ------------------------------------------
function send(target, method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${method}: időtúllépés ${timeoutMs} ms után (a fül renderel egyáltalán?)`));
    }, timeoutMs);
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(`${method}: ${err.message}`));
      else resolve(result);
    });
  });
}

// Egy háttérben lévő fület a headed Chromium NEM renderel, ezért a captureScreenshot
// örökre várna. A fotózandó fület tehát előre kell hozni — utána visszaállítjuk.
async function bringToFront(tab) {
  const [wasActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  const prevWindow = (await chrome.windows.getLastFocused().catch(() => null))?.id ?? null;
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* nem kritikus */ }
  await sleep(250);
  await wakeTab(tab.id);
  return async () => {
    try {
      if (wasActive && wasActive.id !== tab.id) await chrome.tabs.update(wasActive.id, { active: true });
      if (prevWindow && prevWindow !== tab.windowId) await chrome.windows.update(prevWindow, { focused: true });
    } catch { /* a visszaállítás sosem buktathatja el a kész képet */ }
  };
}

async function resolveTab(job) {
  if (job.tabId) return chrome.tabs.get(job.tabId);
  if (job.match) {
    const all = await chrome.tabs.query({});
    const needle = job.match.toLowerCase();
    const hits = all.filter((t) => (t.url || '').toLowerCase().includes(needle)
                                || (t.title || '').toLowerCase().includes(needle));
    if (!hits.length) throw new Error(`nincs fül erre a mintára: ${job.match}`);
    // Több találatnál az első kiválasztása néma tévedés: több session mellett könnyen
    // egy IDEGEN session fülét kapnánk el, helyes képpel, rossz lapról.
    if (hits.length > 1) {
      const list = hits.map((t) => `  --tab ${t.id}  ${(t.title || '').slice(0, 50)}  ${t.url}`).join('\n');
      throw new Error(`${hits.length} fül illik a mintára "${job.match}", nem választok helyetted:\n${list}`);
    }
    return hits[0];
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('nincs aktív fül');
  return active;
}

// Az Edge „alvó fülek" funkciója eldobja a régóta háttérben lévő fülek rendererét.
// Ilyen fülön a debugger csatlakozik, de minden parancs elakad — előbb be kell töltenie.
async function wakeTab(tabId, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (!t.discarded && t.status === 'complete') return t;
    if (Date.now() - started > timeoutMs) {
      // A 'loading' állapot magában nem akadály: egy örökké töltő erőforrás (analitika,
      // stream) mellett a lap már rég kirajzolt, és a fotó így 20 s után elbukna.
      // Csak az eldobott (renderer nélküli) fül menthetetlen.
      if (!t.discarded) return t;
      throw new Error(`a fül nem ébredt fel ${timeoutMs} ms alatt (discarded=${t.discarded}, status=${t.status})`);
    }
    if (t.discarded) await chrome.tabs.reload(tabId);
    await sleep(400);
  }
}

async function viewportSize(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
  });
  return result;
}

// A clip koordinátái CSS-pixelben, a DOKUMENTUM origójához képest —
// captureBeyondViewport mellett ez az, ami a görgetéstől függetlenül helyes.
async function computeClip(tabId, job) {
  if (job.clip) return job.clip;
  const pad = job.padding || 0;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel, pad) => {
      const el = document.querySelector(sel);
      if (!el) return { err: 'notfound' };
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { err: 'zerosize' };
      return {
        x: Math.max(0, r.left + scrollX - pad),
        y: Math.max(0, r.top + scrollY - pad),
        width: r.width + pad * 2,
        height: r.height + pad * 2,
      };
    },
    args: [job.selector, pad],
  });
  if (!result || result.err === 'notfound') throw new Error(`a selector nem talált elemet: ${job.selector}`);
  if (result.err === 'zerosize') throw new Error(`az elem 0 méretű (rejtett?): ${job.selector}`);
  return result;
}

async function capture(job) {
  const tab = await resolveTab(job);
  const mode = job.mode || 'viewport';
  const meta = { tabUrl: tab.url, tabTitle: tab.title, tabId: tab.id };

  // Felvétel alatt a szerver eleve elutasítja a fotózást (a fülváltás befagyasztaná a
  // videót, ugyanarra a fülre pedig nem lehet másodszor csatolni), ezért itt nincs
  // külön ág: ha idáig eljutunk, nem fut felvétel.
  // Árva felvétel (a szerver újraindult alatta) itt is beragadna: a debugger csatolva
  // marad, és az attach „Another debugger is already attached"-del bukna.
  if (rec && rec.tabId === tab.id) {
    console.warn('[edge-shot] árva felvétel a fotózandó fülön, lezárom:', rec.recId);
    try { await recStop({ recId: rec.recId }); } catch { /* nem buktathatja a fotót */ }
  }
  const restore = await bringToFront(tab);
  const target = { tabId: tab.id };
  try {
    // Az attach a try-ON BELÜL: ha bukik (pl. másik eszköz debuggere ül a fülön), a
    // restore különben sosem futna le, és a fül elöl ragadna.
    await chrome.debugger.attach(target, '1.3');
    await send(target, 'Page.enable');
    // Az értesítősáv megjelenése itt is átrendezi a lapot; mérés csak utána.
    await sleep(120);
    const vp = await viewportSize(tab.id);
    // Explicit metrikák: így a kimenet DPR-je determinisztikus, nem a képernyőtől függ.
    const metrics = job.device
      ? { width: job.device.width, height: job.device.height || 812,
          deviceScaleFactor: job.device.deviceScaleFactor || 3, mobile: true }
      : { width: vp.w, height: vp.h,
          deviceScaleFactor: job.scale || 2, mobile: false };

    await send(target, 'Emulation.setDeviceMetricsOverride', metrics);
    if (metrics.mobile) {
      await send(target, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      try {
        await send(target, 'Emulation.setUserAgentOverride', {
          userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
        });
      } catch { /* nem kritikus */ }
    }
    // Az átméretezés után a lapnak kell egy pillanat az újrarendezéshez.
    // Korlát: a settle korlátlanul a 60 s-os feladat-korláton túlvihetné a jobot, és a
    // „zombi" capture a következő job közepén állítaná vissza a fület.
    await sleep(Math.min(10000, job.settleMs ?? (job.device ? 800 : 250)));

    const params = { format: 'png', captureBeyondViewport: mode !== 'viewport' };
    if (mode === 'element' || mode === 'region') params.clip = { ...(await computeClip(tab.id, job)), scale: 1 };

    const { data } = await send(target, 'Page.captureScreenshot', params);
    let dataUrl = 'data:image/png;base64,' + data;
    let barPx = null;
    if (job.urlBar) {
      const bar = await withUrlBar(dataUrl, tab.url, metrics.deviceScaleFactor);
      dataUrl = bar.dataUrl;
      barPx = bar.barPx;
    }
    const twin = await jpegTwin(dataUrl, job.jpegMaxPx, job.jpegQuality, job.tiles);
    return { dataUrl, barPx, scaleUsed: metrics.deviceScaleFactor, ...twin, ...meta };
  } finally {
    try { await send(target, 'Emulation.clearDeviceMetricsOverride'); } catch { /* takarítás */ }
    try { await send(target, 'Emulation.setTouchEmulationEnabled', { enabled: false }); } catch { /* takarítás */ }
    try { await chrome.debugger.detach(target); } catch { /* takarítás */ }
    await restore();
  }
}

// A kész képet FELÜL bővítjük egy fehér sávval, amiben feketén ott az URL.
// Miért utólag és nem a lapba injektálva: a lapba tett sáv vagy elmozdítja a tartalmat
// (és elrontja az elem-mód mért téglalapját), vagy fixed elemként kiszámíthatatlan helyre
// kerül a captureBeyondViewport melletti teljes-lap képen.
async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/png'};base64,` + btoa(bin);
}

// Hosszú URL-t KÖZÉPEN rövidítünk: a hoszt és a záró útvonal-szakasz a beszédes rész,
// a végéről vágás épp azt dobná el, ami azonosítja a lapot.
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let head = Math.floor(text.length / 2);
  let tail = text.length - head;
  while (head + tail > 12) {
    if (head > tail) head--; else tail--;
    const candidate = text.slice(0, head) + '…' + text.slice(text.length - tail);
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
  }
  return text.slice(0, 12) + '…';
}

async function withUrlBar(dataUrl, url, scale) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = Math.max(1, scale || 2);
  const font = Math.round(15 * k);
  const padX = Math.round(14 * k);
  const padY = Math.round(11 * k);
  const barH = font + padY * 2;

  const canvas = new OffscreenCanvas(bmp.width, bmp.height + barH);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, barH);

  ctx.fillStyle = '#000000';
  ctx.font = `${font}px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(fitText(ctx, url, canvas.width - padX * 2), padX, Math.round(barH / 2));

  ctx.fillStyle = '#cccccc';
  ctx.fillRect(0, barH - Math.max(1, Math.round(k)), canvas.width, Math.max(1, Math.round(k)));

  ctx.drawImage(bmp, 0, barH);
  bmp.close();
  const out = await blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
  return { dataUrl: out, barPx: barH };
}

// A kicsinyített JPEG-ikret ITT készítjük, nem a szerveren: a szerver korábban a macOS-es
// `sips`-re támaszkodott, így Linuxon/Windowson se méret, se iker nem lett, és Claude a
// DPR 2-es PNG-t olvasta be (sokszoros token-költség). A böngésző mindenhol tud JPEG-et.
// A szélességet korlátozzuk, sosem a leghosszabb oldalt (lásd DESIGN: a 68 px-es szilánk).
// Egy csempe mérete a modell képkorlátjához igazodik (~1,15 MP, hosszabb oldal ≤ 1568):
// ennél nagyobbat beolvasáskor úgyis kicsinyítene, és a szöveg olvashatatlanná válna.
// A csempék átfednek, hogy a határra eső sor egyikben egészben látszódjon.
const TILE_MAX_PX = 1_150_000;
const TILE_OVERLAP = 48;

async function jpegTiles(canvas, w, h, q) {
  const tileH = Math.max(400, Math.min(1568, Math.floor(TILE_MAX_PX / w)));
  const step = tileH - TILE_OVERLAP;
  const tiles = [];
  for (let y = 0; y < h; y += step) {
    const th = Math.min(tileH, h - y);
    if (tiles.length && th <= TILE_OVERLAP) break;  // csak átfedés maradt: nincs új tartalom
    const c = new OffscreenCanvas(w, th);
    c.getContext('2d').drawImage(canvas, 0, y, w, th, 0, 0, w, th);
    tiles.push(await blobToDataUrl(await c.convertToBlob({ type: 'image/jpeg', quality: q })));
    if (y + th >= h) break;
  }
  return { tiles, tileH };
}

// `tiles`: true = mindig, false = soha, undefined = automatikusan, ha a kép legalább
// két csempényi magas (ekkor az egyben olvasott JPEG már olvashatatlan lenne).
async function jpegTwin(pngDataUrl, maxPx, quality, tiles) {
  try {
    const bmp = await createImageBitmap(await (await fetch(pngDataUrl)).blob());
    const width = bmp.width, height = bmp.height;
    const k = maxPx && width > maxPx ? maxPx / width : 1;
    const w = Math.max(1, Math.round(width * k)), h = Math.max(1, Math.round(height * k));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';            // átlátszó PNG-háttér JPEG-ben feketévé válna
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const q = (quality ?? 55) / 100;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    const jpegDataUrl = await blobToDataUrl(blob);
    const out = { width, height, jpegDataUrl, jpegWidth: w, jpegHeight: h };
    const autoTileH = Math.max(400, Math.min(1568, Math.floor(TILE_MAX_PX / w)));
    if (tiles === true || (tiles !== false && h > autoTileH * 2)) {
      const t = await jpegTiles(canvas, w, h, q);
      if (t.tiles.length > 1) { out.jpegTiles = t.tiles; out.tileHeight = t.tileH; }
    }
    return out;
  } catch (e) {
    return { jpegErr: String(e?.message || e) };
  }
}

async function jpegSize(dataB64) {
  try {
    const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + dataB64)).blob());
    const r = { w: bmp.width, h: bmp.height };
    bmp.close();
    return r;
  } catch { return { w: null, h: null }; }
}

// A screencast újrafegyverzése. Idempotens: a Page.startScreencast egy már futó
// castot újraindít, ezért a kétszeres hívás (frameNavigated + loadEventFired)
// ártalmatlan. A késleltetés MÉRT szükséglet: a navigáció utáni első pillanatban a
// renderer még nem rajzol, és az azonnali indítás kockátlan castot adott.
function rearmCast(state, why) {
  if (!state.castParams) return;
  state.rearms++;
  setTimeout(() => {
    if (rec !== state) return;
    chrome.debugger.sendCommand(state.target, 'Page.startScreencast', state.castParams, () => {
      const err = chrome.runtime.lastError;
      if (err) console.warn('[edge-shot] a screencast újrafegyverzése elbukott (' + why + '):', err.message);
    });
  }, 300);
}

// Folyamat-váltós navigáció után a debugger lecsatolódhat. Visszacsatolunk, újra
// engedélyezzük a Page domaint, és újraindítjuk a castot.
async function reattachCast(state) {
  if (rec !== state) return;
  try {
    await chrome.debugger.attach(state.target, '1.3');
    await send(state.target, 'Page.enable');
    await send(state.target, 'Page.startScreencast', state.castParams);
    state.detached = null;
    console.warn('[edge-shot] visszacsatoltam a felvételt lecsatolás után:', state.recId);
  } catch (e) {
    console.warn('[edge-shot] a visszacsatolás elbukott:', e?.message || e);
  }
}

// A szakaszhatárt a szerver is megkapja, hogy a rec-stop szakaszonként tudjon
// kocka-számot mondani. Tűzz-és-felejts: egy elveszett jelzés nem buktathatja a felvételt.
function reportNav(state, seq, url) {
  fetch(`${BASE}/rec/nav`, {
    method: 'POST',
    headers: { ...HDR, 'content-type': 'application/json' },
    body: JSON.stringify({ recId: state.recId, seq, url }),
  }).catch(() => { /* a stop úgyis kiírja a szakaszokat a saját könyveléséből */ });
}

async function recStart(job) {
  // A szerver csak akkor küld recstart-ot, ha NÁLA nincs aktív felvétel. Ha itt mégis van
  // egy, az árva (a szerver újraindult vagy összeomlott): zárjuk le, ne holtpontoljunk.
  // Enélkül egy mozdulatlan lapon a slot SOHA nem szabadulna fel (nincs kocka, nincs drop).
  if (rec) {
    console.warn('[edge-shot] árva felvétel a bővítményben, lezárom:', rec.recId);
    try { await recStop({ recId: rec.recId }); } catch { /* a lezárás nem buktathatja az újat */ }
  }
  const tab = await resolveTab(job);
  const restore = await bringToFront(tab);
  const target = { tabId: tab.id };

  const state = {
    recId: job.recId, target, tabId: tab.id, restore, seq: 0,
    ackDelayMs: job.ackDelayMs || 0, hiddenSince: null, hiddenSec: 0,
    onEvent: null, onDetach: null, firstSize: null,
    // Lapváltás-könyvelés. A screencast a DOKUMENTUMHOZ kötött:
    // egy fő-keretes navigáció után a böngésző NEM küld több kockát, hacsak újra nem
    // fegyverezzük. Enélkül a felvétel a navigáció előtti lapon befagy, miközben a
    // hossza és a kocka-száma hibátlannak LÁTSZIK — ez a legrosszabb fajta néma hiba
    // egy bizonyíték-eszközben. Mérve 2026-09-21: két 70 mp-es felvétel, mindkettő a
    // lapváltásnál fagyott be, és a rec-stop kimenete ezt semmivel nem jelezte.
    castParams: null, navs: [], framesSinceNav: 0, rearms: 0, reattaches: 0,
  };

  try {
    // Az attach a try-ON BELÜL, ugyanazért, mint a capture-ben.
    await chrome.debugger.attach(target, '1.3');
    await send(target, 'Page.enable');
    // A debugger-értesítősáv megjelenése átrendezi a lapot, ezért a mérés UTÁNA megy.
    await sleep(350);

    const vp = await viewportSize(tab.id);
    let cssRect = null;
    if (job.selector) {
      // FIGYELEM: a screencast-kocka a VIEWPORT képe, nem a dokumentumé. A `computeClip`
      // dokumentum-koordinátát ad (scrollX/scrollY-nal eltolva) — az az állóképhez helyes,
      // ITT viszont görgetett lapon némán rossz sávot vágna ki.
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return { err: 'notfound' };
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) return { err: 'zerosize' };
          // A 0-ra vágásnál a szélességet/magasságot is csökkenteni kell, különben egy
          // részben képernyőn kívüli elemnél a vágás a SZOMSZÉDOS tartalmat is bevenné.
          const x = Math.max(0, r.left), y = Math.max(0, r.top);
          return { x, y, width: r.width - (x - r.left), height: r.height - (y - r.top) };
        },
        args: [job.selector],
      });
      if (!result || result.err === 'notfound') throw new Error(`a selector nem talált elemet: ${job.selector}`);
      if (result.err === 'zerosize') throw new Error(`az elem 0 méretű (rejtett?): ${job.selector}`);
      cssRect = result;
    }

    state.castParams = {
      format: 'jpeg', quality: job.quality, maxWidth: job.maxWidth,
      maxHeight: 4000, everyNthFrame: 1,
    };
    await send(target, 'Page.startScreencast', state.castParams);

    state.onEvent = (src, method, params) => {
      if (src.tabId !== state.tabId) return;
      if (method === 'Page.screencastVisibilityChanged') {
        // Rejtett fület a böngésző nem renderel: a videó befagyna. Mérjük a rést.
        if (params.visible === false) state.hiddenSince = Date.now();
        else if (state.hiddenSince) {
          state.hiddenSec += (Date.now() - state.hiddenSince) / 1000;
          state.hiddenSince = null;
        }
        return;
      }
      // Fő-keretes navigáció: jelöljük a szakaszhatárt, és fegyverezzük újra a
      // screencastot. A `parentId` hiánya azonosítja a fő keretet; az iframe-ek
      // navigációja (egy beágyazott vászon is az) nem szakaszhatár és nem is töri el a
      // kockafolyamot, ezért azokra NEM indítunk újra semmit.
      if (method === 'Page.frameNavigated' && !params.frame?.parentId) {
        state.navs.push({ seq: state.seq, url: params.frame?.url || null, at: Date.now() });
        state.framesSinceNav = 0;
        reportNav(state, state.seq, params.frame?.url || null);
        rearmCast(state, 'frameNavigated');
        return;
      }
      // A load után még egyszer, DE csak ha tényleg nem jött kocka: a felesleges
      // újraindítás egy működő felvételnél kockát ejtene.
      if (method === 'Page.loadEventFired') {
        if (state.framesSinceNav === 0) rearmCast(state, 'loadEventFired');
        return;
      }
      if (method !== 'Page.screencastFrame') return;
      state.framesSinceNav++;
      const seq = ++state.seq;
      const ts = params.metadata?.timestamp ?? Date.now() / 1000;
      const data = params.data;
      const ack = () => chrome.debugger.sendCommand(target, 'Page.screencastFrameAck', { sessionId: params.sessionId }, () => void chrome.runtime.lastError);
      if (state.ackDelayMs) setTimeout(ack, state.ackDelayMs); else ack();
      sendFrame(state, seq, ts, data);
    };
    // A lecsatolás nem feltétlenül végleges: egy folyamat-váltós navigáció is leválthatja
    // a debuggert. Korlátozott számú visszacsatolást megkísérlünk, de a tényt MEGTARTJUK
    // a jelentésben, hogy a szakasz-statisztika mellett látszódjon, mi történt.
    state.onDetach = (src, reason) => {
      if (src.tabId !== state.tabId) return;
      state.detached = reason || 'ismeretlen ok';
      if (rec !== state) return;
      // A felhasználó a „Mégse" gombbal kifejezetten leállította a hibakeresést, vagy a fül
      // bezárult: ilyenkor a visszacsatolás vagy a felhasználó akarata ellen menne, vagy
      // értelmetlen. A tényt a jelentés (detachReason) kimondja.
      if (reason === 'canceled_by_user' || reason === 'target_closed') return;
      if (state.reattaches >= 3) return;
      state.reattaches++;
      setTimeout(() => { void reattachCast(state); }, 250);
    };
    chrome.debugger.onEvent.addListener(state.onEvent);
    chrome.debugger.onDetach.addListener(state.onDetach);

    rec = state;

    // A crop-szorzó MÉRT: frameW / metadata.deviceWidth. A DPR-rel számolás mérve
    // 2,8-szeresen mellényúlna (maxWidth 1280 mellett a szorzó 0,714, nem 2).
    return {
      tabUrl: tab.url, tabTitle: tab.title, tabId: tab.id,
      geometry: { cssViewport: vp, maxWidth: job.maxWidth },
      cssRect, pendingCropFrom: 'first-frame',
    };
  } catch (e) {
    try { await chrome.debugger.detach(target); } catch { /* takarítás */ }
    await restore();
    rec = null;
    throw e;
  }
}

async function sendFrame(state, seq, ts, dataB64) {
  const bin = Uint8Array.from(atob(dataB64), (c) => c.charCodeAt(0));
  if (!state.firstSize) state.firstSize = await jpegSize(dataB64);
  try {
    const r = await fetch(`${BASE}/rec/frame`, {
      method: 'POST',
      headers: {
        ...HDR, 'content-type': 'image/jpeg',
        'x-rec-id': state.recId, 'x-seq': String(seq), 'x-ts': String(ts),
        'x-w': String(state.firstSize.w ?? ''), 'x-h': String(state.firstSize.h ?? ''),
        'x-hidden-sec': String(state.hiddenSec.toFixed(2)),
      },
      body: bin,
    });
    // Ha a szerver már nem ismeri ezt a felvételt (lejárt vagy törölt job), a bővítmény
    // slotja különben ÖRÖKRE foglalt maradna, és minden további rec-start elbukna.
    const j = await r.json().catch(() => ({}));
    if (j.drop) {
      state.drops = (state.drops || 0) + 1;
      if (state.drops > 20 && rec === state) {
        await recStop({ recId: state.recId });
      }
    } else state.drops = 0;
  } catch { /* a szerver eltűnt; a stop úgyis kiderít mindent */ }
}

async function recStop(job) {
  if (!rec) return { stopped: false, note: 'nem futott felvétel ebben a bővítményben' };
  if (job.recId && rec.recId && job.recId !== rec.recId) {
    return { stopped: false, note: `a kért felvétel (${job.recId}) nem ez (${rec.recId})` };
  }
  const state = rec;
  rec = null;
  if (state.hiddenSince) state.hiddenSec += (Date.now() - state.hiddenSince) / 1000;
  chrome.debugger.onEvent.removeListener(state.onEvent);
  chrome.debugger.onDetach.removeListener(state.onDetach);
  try { await send(state.target, 'Page.stopScreencast'); } catch { /* lehet, hogy lecsatolt */ }
  try { await chrome.debugger.detach(state.target); } catch { /* lehet, hogy más bontotta */ }
  await state.restore();
  return {
    stopped: true, frames: state.seq, hiddenSec: state.hiddenSec,
    frameSize: state.firstSize, detachReason: state.detached || null,
    navs: state.navs, rearms: state.rearms, reattaches: state.reattaches,
  };
}

async function listTabs() {
  const all = await chrome.tabs.query({});
  return {
    tabs: all.map((t) => ({
      id: t.id, title: t.title, url: t.url,
      active: t.active, windowId: t.windowId,
    })),
  };
}

// Elem-mód előtt: melyik selector mit talál, és mekkora. Így nem vaktában fotózunk.
async function probe(job) {
  const tab = await resolveTab(job);
  // Az executeScript háttérben lévő fülön is fut: a szondázás NEM hozza előre a fület.
  // Így nincs villanás, gyorsabb, és egy futó felvételt sem fagyaszthat be. Csak az
  // eldobott (renderer nélküli) fület kell felébreszteni.
  if (tab.discarded) await wakeTab(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      let els;
      try { els = [...document.querySelectorAll(sel)]; }
      catch (e) { return { error: `hibás selector: ${e.message}` }; }
      return {
        count: els.length,
        matches: els.slice(0, 10).map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 70) || null,
            w: Math.round(r.width), h: Math.round(r.height),
            visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
          };
        }),
      };
    },
    args: [job.selector],
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

// A lap SZÖVEGE kép helyett: ha a kérdés az, hogy mi áll a lapon (hibaüzenet, érték,
// lista), a szöveg töredék tokenből megválaszolja, és a fület sem kell előrehozni.
async function pageText(job) {
  const tab = await resolveTab(job);
  if (tab.discarded) await wakeTab(tab.id);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, links) => {
      let root = document.body;
      if (sel) {
        try { root = document.querySelector(sel); }
        catch (e) { return { error: `hibás selector: ${e.message}` }; }
        if (!root) return { error: `a selector nem talált elemet: ${sel}` };
      }
      const text = (root?.innerText || '')
        .split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n')
        // Az üres sorok a <p>-k közt tokenbe kerülnek, információt nem hordoznak.
        .replace(/\n{2,}/g, '\n').trim();
      const out = { text };
      if (links) {
        const seen = new Set();
        out.links = [...(root?.querySelectorAll('a[href]') || [])]
          .map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80), href: a.href }))
          .filter((l) => l.href && !l.href.startsWith('javascript:') && !seen.has(l.href) && seen.add(l.href))
          .slice(0, 200);
      }
      return out;
    },
    args: [job.selector || null, !!job.links],
  });
  if (!result) throw new Error('a lap nem adott vissza szöveget');
  if (result.error) throw new Error(result.error);
  const max = job.maxChars || 8000;
  return {
    tabUrl: tab.url, tabTitle: tab.title, tabId: tab.id,
    chars: result.text.length, truncated: result.text.length > max,
    text: result.text.slice(0, max), links: result.links || null,
  };
}

async function handle(job) {
  if (job.kind === 'recstart') return recStart(job);
  if (job.kind === 'recstop') return recStop(job);
  if (job.kind === 'tabs') return listTabs();
  if (job.kind === 'probe') return probe(job);
  if (job.kind === 'text') return pageText(job);
  if (job.kind === 'reload') {
    // A választ még a régi kód küldi el; az újratöltés utána indul.
    setTimeout(() => chrome.runtime.reload(), 500);
    return { reloading: true };
  }
  return capture(job);
}

// --- long-poll ciklus ---------------------------------------------------
async function loop() {
  if (looping) return;
  looping = true;
  await ready;
  try {
    for (;;) {
      let job;
      try {
        lastPollAt = Date.now();
        const r = await fetch(`${BASE}/poll`, { headers: HDR });
        if (r.status === 204) continue;          // tartás lejárt, újra
        if (!r.ok) { await sleep(3000); continue; }
        job = await r.json();
      } catch {
        await sleep(3000);                       // a szerver nem fut
        continue;
      }
      let payload;
      try {
        payload = { id: job.id, ok: true, ...(await withTimeout(handle(job), 60000, 'a feladat nem fejeződött be')) };
      } catch (e) {
        payload = { id: job.id, ok: false, error: String((e && e.message) || e) };
      }
      try {
        await fetch(`${BASE}/result`, {
          method: 'POST',
          headers: { ...HDR, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch { /* a szerver eltűnt; a következő poll úgyis elbukik */ }
    }
  } finally {
    looping = false;
  }
}

// A service worker bármikor leállhat; minden felébresztési esemény újraindítja a ciklust.
// Az ébresztőt a worker MINDEN indulásakor létre kell hozni, nem csak telepítéskor:
// a `chrome.runtime.reload()` (a `shot reload` parancs) törli az ébresztőket, és az
// `onInstalled` újratöltéskor nem fut le. Enélkül egy elhalt worker sosem éledne fel.
chrome.alarms.create('edge-shot-keepalive', { periodInMinutes: 1 });
chrome.runtime.onInstalled.addListener(loop);
chrome.runtime.onStartup.addListener(loop);
chrome.alarms.onAlarm.addListener(() => {
  // Beragadt ciklus: fut, de rég nem pollozott. Egy néma bővítmény a legrosszabb hibamód,
  // ezért inkább újraindítjuk magunkat, mint hogy elérhetetlen maradjon.
  if (looping && lastPollAt && Date.now() - lastPollAt > 90_000) {
    chrome.runtime.reload();
    return;
  }
  loop();
});
chrome.action.onClicked.addListener(loop);
loop();
