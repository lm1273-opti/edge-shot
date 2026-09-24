#!/usr/bin/env node
// edge-shot server — loopback-only job broker between the CLI and the browser extension.
// Zero dependencies. Claude POSTs a job; the extension long-polls for it and posts the result back.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A gyökér a SZKRIPT helye, nem a HOME: máshova klónozva is működnie kell.
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// A kimenet a BEJELENTKEZETT böngésző képe: bizalmas. Alapértelmezett umask (022) mellett
// 644-es fájlok és 755-ös könyvtárak keletkeznének, amit közös gépen bárki elolvashat.
process.umask(0o077);

const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const OUT_ROOT = CFG.outRoot
  ? CFG.outRoot.replace(/^~(?=\/|$)/, os.homedir())
  : path.join(os.homedir(), '.claude', 'screenshots');
const PORT = CFG.port || 8765;
const TOKEN = CFG.token;
if (typeof TOKEN !== 'string' || TOKEN.length < 16) {
  console.error('[edge-shot] a config.json-ban nincs használható token. Futtasd újra az install.sh-t.');
  process.exit(1);
}
const JPEG_MAX_PX = CFG.jpegMaxPx ?? 1200;
const JPEG_QUALITY = CFG.jpegQuality ?? 55;

const POLL_HOLD_MS = 25_000;   // under the MV3 30s service-worker idle limit
const JOB_TIMEOUT_MS = 90_000;

// --- felvétel-állapot -------------------------------------------------
// A felvétel NEM job: egy job legfeljebb 60 s-ig élhet a bővítményben, és amíg fut,
// a poll-ciklus nem pollozik, tehát a rec-stop sem jutna át. Ezért a start és a stop
// két RÖVID job, a felvétel maga itt él, a kockák külön útvonalon érkeznek.
const recordings = new Map();  // recId -> állapot
let activeRecId = null;
const REC_MAX_SEC = 120;
const RESAMPLE_FPS = 30;

const PRESETS = {
  // Az ack-késleltetés MÉRT fék (2026-09-15): 0->90, 40->57, 100->27, 200->14 kocka/mp.
  // Nem ejtünk kockát: a böngésző nem is gyártja azt, amit nem nyugtázunk.
  low:    { quality: 45, maxWidth: 900,  ackDelayMs: 260 },
  normal: { quality: 70, maxWidth: 1400, ackDelayMs: 100 },
  high:   { quality: 85, maxWidth: 1800, ackDelayMs: 30  },
};

const queue = [];              // jobs not yet handed to the extension
const waiters = [];            // held GET /poll responses
const inflight = new Map();    // jobId -> { resolve, reject, timer }
let extensionLastSeen = 0;
// Böngésző -> utolsó jelentkezés. Egyszerre CSAK EGY böngésző szolgálhat ki feladatokat:
// a fül-azonosítók böngészőnként mások, tehát két betöltött bővítmény mellett egy `--tab`
// a rossz böngésző egy létező fülét fotózhatná le, és a kép helyesnek LÁTSZANA.
const browsers = new Map();
const BROWSER_TTL = 60_000;

function liveBrowsers() {
  const now = Date.now();
  for (const [b, t] of browsers) if (now - t > BROWSER_TTL) browsers.delete(b);
  // Egy azonosító nélküli régi bejegyzés („Edge") és egy azonosítós („Edge#ab12cd34")
  // ugyanaz a böngésző a bővítmény újratöltése után: különben a `shot reload` után 60 s-ig
  // hamis „két böngésző" tiltás lenne.
  for (const b of browsers.keys()) {
    if (!b.includes('#') && [...browsers.keys()].some((o) => o.startsWith(b + '#'))) browsers.delete(b);
  }
  return [...browsers.keys()];
}

function multiBrowserBlock() {
  const live = liveBrowsers();
  if (live.length < 2) return null;
  return `KÉT BÖNGÉSZŐ csatlakozik egyszerre (${live.join(', ')}). A fül-azonosítók böngészőnként mások, ezért nem tudom eldönteni, melyikre gondolsz, és nem tippelek: egy rossz böngészőből készült kép helyesnek LÁTSZANA. Távolítsd el a bővítményt az egyikből, aztán próbáld újra.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((res, rej) =>
  execFile(cmd, args, (e, out) => (e ? rej(e) : res(out))));

function dispatch() {
  while (queue.length && waiters.length) {
    const res = waiters.shift();
    clearTimeout(res.__holdTimer);
    // Egy elhalt service worker poll-kapcsolata a 'close' esemény előtt még a listában
    // lehet: ha ide küldenénk a jobot, elveszne, és csak 90 s múlva derülne ki.
    if (res.destroyed || res.writableEnded) continue;
    const job = queue.shift();
    send(res, 200, job);
  }
}

function enqueue(job) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(job.id);
      // A lejárt jobot KI KELL VENNI a sorból: különben később „szellem-jobként" lefut,
      // fület ránt előre egy idegen session felvétele alatt, vagy elindít egy felvételt,
      // amiről a szerver már nem tud (és amit semmi nem állít le).
      const qi = queue.findIndex((j) => j.id === job.id);
      const wasQueued = qi >= 0;
      if (wasQueued) queue.splice(qi, 1);
      reject(new Error(
        wasQueued
          ? `időtúllépés: a feladat ${Math.round(JOB_TIMEOUT_MS / 1000)} s alatt nem lett kiosztva (sorban maradt ${queue.length} elem). Fut a böngésző, és csatlakozik a bővítmény? shot health`
          : 'időtúllépés: a bővítmény átvette a feladatot, de nem válaszolt'));
    }, JOB_TIMEOUT_MS);
    inflight.set(job.id, { resolve, reject, timer });
    queue.push(job);
    dispatch();
  });
}

function send(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

// MÉRVE 2026-09-15: két session ugyanabban a másodpercben ugyanazzal a névvel UGYANARRA
// az útra írt, az egyik felülírta a másikat, és MINDKETTŐ sikert jelentett. Az `wx` mód
// az egyetlen atomi módja annak, hogy a névfoglalás ne legyen versenyeztethető.
function claimPath(dir, base, ext) {
  for (let n = 1; n < 500; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`;
    const full = path.join(dir, name);
    try { fs.closeSync(fs.openSync(full, 'wx')); return full; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('nem sikerült szabad fájlnevet foglalni');
}

function slugify(s) {
  return String(s || 'shot').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'shot';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}

async function persist(job, dataUrl, meta) {
  if (typeof dataUrl !== 'string') throw new Error('a bővítmény nem küldött képet');
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const png = Buffer.from(b64, 'base64');
  const { day, time } = stamp();
  const dir = path.join(OUT_ROOT, day);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const base = `${time}-${slugify(job.name)}`;
  const pngPath = claimPath(dir, base, '.png');
  fs.writeFileSync(pngPath, png);

  // A JPEG-ikret és a méretet a bővítmény adja (platformfüggetlen). A `sips` csak
  // tartalék egy még újra nem töltött, régi bővítményhez.
  if (typeof meta?.jpegDataUrl === 'string') {
    const jpgPath = pngPath.replace(/\.png$/, '.jpg');
    const jpg = Buffer.from(meta.jpegDataUrl.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
    fs.writeFileSync(jpgPath, jpg);
    // Magas képnél a csempék a beolvasható változat: mind a modell képkorlátján belül.
    const tilePaths = [];
    if (Array.isArray(meta.jpegTiles)) {
      meta.jpegTiles.forEach((t, i) => {
        const tp = pngPath.replace(/\.png$/, `-t${String(i + 1).padStart(2, '0')}.jpg`);
        fs.writeFileSync(tp, Buffer.from(String(t).replace(/^data:image\/jpeg;base64,/, ''), 'base64'));
        tilePaths.push(tp);
      });
    }
    return {
      pngPath, pngBytes: png.length, jpgPath, jpgBytes: jpg.length, jpgErr: null,
      tilePaths, tileHeight: meta.tileHeight ?? null,
      width: meta.width ?? null, height: meta.height ?? null,
      jpgWidth: meta.jpegWidth ?? null, jpgHeight: meta.jpegHeight ?? null,
      tabUrl: meta?.tabUrl ?? null, tabTitle: meta?.tabTitle ?? null,
    };
  }

  let width = meta?.width ?? null, height = meta?.height ?? null;
  if (!width) try {
    const out = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', pngPath]);
    width = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1]) || null;
    height = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1]) || null;
  } catch {
    // Nincs sips (nem macOS): ezt KI KELL MONDANI, nem elnyelni, különben a hívó
    // null×null méretet lát és nem érti, miért.
    console.error('[edge-shot] nincs sips: a kép mérete ismeretlen marad (nem macOS?)');
  }

  // Artifact-barát iker: base64-ben ~1 token/karakter, ezért a JPEG a beágyazható változat.
  // A SZÉLESSÉGET korlátozzuk, sosem a leghosszabb oldalt: a `sips -Z` egy magas
  // teljes-lap képnél a magasságot vágná le, és a szélesség 68 px-es szilánkká zsugorodna.
  let jpgPath = null, jpgBytes = null, jpgErr = null;
  try {
    jpgPath = pngPath.replace(/\.png$/, '.jpg');
    const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY)];
    if (width && width > JPEG_MAX_PX) args.push('--resampleWidth', String(JPEG_MAX_PX));
    args.push(pngPath, '--out', jpgPath);
    await run('sips', args);
    jpgBytes = fs.statSync(jpgPath).size;
  } catch (e) {
    // A hívó sosem látja a szerver logját (a szerver háttérben fut), ezért a hibát a
    // válaszban kell visszaadni, különben a JPEG-iker némán elmarad.
    jpgErr = [meta?.jpegErr, e.message].filter(Boolean).join('; ');
    jpgPath = null;
  }

  return {
    pngPath, pngBytes: png.length, jpgPath, jpgBytes, jpgErr,
    width, height, tabUrl: meta?.tabUrl ?? null, tabTitle: meta?.tabTitle ?? null,
  };
}

// A helyes szabály: nem a fotózás általában tilos felvétel alatt, hanem az, ami a
// felvett fültől ELTÉRŐ fület hozna előre. Ugyanarra a fülre a fotózás azért tilos,
// mert a debugger már csatolva van. (A szondázás nem hoz előre fület, arra nem kell.)
function recordingBlock(tabId, what) {
  if (!activeRecId) return null;
  const rec = recordings.get(activeRecId);
  if (!rec) return null;
  if (tabId && rec.tabId && Number(tabId) === Number(rec.tabId)) {
    return `felvétel fut ezen a fülön ("${rec.name}", tulajdonos ${rec.owner}). A felvett fülről a videó a bizonyíték; állókép csak rec-stop után.`;
  }
  return `felvétel fut a(z) ${rec.tabUrl || '?'} fülön (tab ${rec.tabId}, tulajdonos ${rec.owner}); más fül ${what}a előhozná azt a fület, és a videó némán befagyna. Várd meg a rec-stop-ot, vagy: shot rec-stop --force`;
}

function jobBlocked() { return multiBrowserBlock(); }

function tokenOk(req) {
  const t = req.headers['x-shot-token'];
  if (typeof t !== 'string') return false;
  // A hosszt BÁJTBAN kell egyeztetni: egy nem-ASCII fejléc karakterhossza egyezhet, a
  // bájthossza nem, és a timingSafeEqual ilyenkor kivételt dob (500 a 401 helyett).
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A crop-szorzót MÉRJÜK: frameW / CSS-viewport szélesség. A DPR-rel számolás
// mérve 2,8-szeresen mellényúlna (maxWidth 1280 mellett a szorzó 0,714, nem 2).
// Két helyről hívódik: kocka-érkezéskor, és a recstart-válasz után az addig beérkezett
// első kockára — mozdulatlan lapon az indításkori kocka lehet az egyetlen.
function resolveCrop(rec, fw, fh) {
  if (rec.cropResolved || !rec.cssRect || !fw || !rec.geometry?.cssViewport?.w) return;
  const k = fw / rec.geometry.cssViewport.w;
  const r = rec.cssRect;
  rec.crop = {
    x: Math.max(0, r.x * k), y: Math.max(0, r.y * k),
    w: Math.min(fw - Math.max(0, r.x * k), r.width * k),
    h: Math.min((fh || 1e9) - Math.max(0, r.y * k), r.height * k),
  };
  rec.cropScale = Number(k.toFixed(4));
  rec.cropResolved = true;
}

function recDir(recId) { return path.join(os.tmpdir(), 'edge-shot-rec-' + recId); }

// A kockák időbélyege a lapról jön (epoch mp). Fix 30 fps-re mintavételezünk: minden
// tickre a LEGUTÓBBI kocka. Ez adja a valós idejű lejátszást; a concat demuxer
// per-kocka `duration`-je MÉRVE hamis hosszt ad (4,5 s helyett 2,56 s).
// A videó hossza a felvétel VALÓS hossza (fal-óra), nem az első és utolsó kocka
// közti idő. Változás-vezérelt forrásnál ez a különbség végzetes: egy mozdulatlan
// lapról 1 kocka jön, amiből a kocka-ív 0 mp, és MÉRVE egy 0 másodperces „sikeres"
// videó lett 5 mp kérés helyett. A helyes válasz egy 5 mp-es, mozdulatlan felvétel.
// Ugyanez teszi láthatóvá a rejtett fül miatti befagyást a maga valós hosszában.
function resample(frames, fps, t0, t1) {
  if (!frames.length) return [];
  const span = Math.max(1 / fps, t1 - t0);
  const ticks = Math.max(1, Math.round(span * fps));
  const out = [];
  let i = 0;
  for (let k = 0; k < ticks; k++) {
    const t = t0 + k / fps;
    while (i + 1 < frames.length && frames[i + 1].ts <= t) i++;
    out.push(frames[i]);
  }
  return out;
}

async function encode(rec) {
  // A kockák párhuzamos fetch-ekkel érkeznek, a sorrendjük NEM garantált; a
  // mintavételezés viszont rendezettséget feltételez. Rendezés a sorszám szerint.
  rec.frames.sort((a, b) => a.seq - b.seq);
  const dir = rec.dir;
  const seqDir = path.join(dir, 'seq');
  fs.mkdirSync(seqDir, { recursive: true, mode: 0o700 });
  // A kockák időbélyege a lapról jön (epoch mp), a felvétel határai szintén epoch-alapúak.
  const wallStart = rec.startedAt / 1000;
  const wallEnd = (rec.stoppedAt || Date.now()) / 1000;
  const picked = resample(rec.frames, RESAMPLE_FPS, Math.min(wallStart, rec.frames[0].ts), wallEnd);

  // A kapu a KÓDOLÁS ELŐTT: korábban utána állt, így a hibaüzenet azt állította, hogy nem
  // adok ki vágatlan videót, miközben az ffmpeg már ki is írta a lemezre. Egy hibaüzenet,
  // ami mást mond, mint ami a lemezen van, rosszabb, mint a hiba maga.
  if (rec.cssRect && !rec.cropResolved) {
    throw new Error('a vágás nem volt feloldható (a kocka pixelmérete ismeretlen maradt); vágás-kérésre nem adok ki vágatlan videót');
  }
  picked.forEach((f, idx) => {
    const dst = path.join(seqDir, String(idx + 1).padStart(6, '0') + '.jpg');
    try { fs.linkSync(f.file, dst); } catch { fs.copyFileSync(f.file, dst); }
  });

  const { day, time } = rec.stamp;
  const outDir = path.join(OUT_ROOT, day);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const base = `${time}-${slugify(rec.name)}`;
  const mp4 = claimPath(outDir, base, '.mp4');

  // A crop a KOCKA pixelrácsában megy, a mért szorzóval; a páros méretet a szűrő
  // kényszeríti ki, mert a páratlan méret + yuv420p MÉRVE 0 bájtos fájlt ad.
  const filters = [];
  if (rec.crop) {
    const c = rec.crop;
    filters.push(`crop=trunc(${Math.round(c.w)}/2)*2:trunc(${Math.round(c.h)}/2)*2:${Math.round(c.x)}:${Math.round(c.y)}`);
  } else {
    filters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0');
  }
  filters.push('setsar=1');

  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(RESAMPLE_FPS), '-i', path.join(seqDir, '%06d.jpg'),
    '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', String(rec.crf ?? 23), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);

  let gif = null;
  if (rec.gif) {
    gif = mp4.replace(/\.mp4$/, '.gif');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', String(RESAMPLE_FPS), '-i', path.join(seqDir, '%06d.jpg'),
      '-vf', `${filters.join(',')},fps=10,split[a][b];[a]palettegen[p];[b][p]paletteuse`, gif]);
  }

  // ── Ellenőrző kockák ──────────────────────────────────────────────────────────
  // A videó hossza semmit nem igazol: egy lapváltásnál befagyott felvétel is teljes
  // hosszú. Az egyetlen olcsó ellenőrzés a KOCKA megnézése, ezért kirakjuk őket fájlba,
  // hogy egy Read-del ránézhess. Alapból minden navigációt tartalmazó felvételnél fut.
  let verifyDir = null; let verifyFiles = [];
  const wantVerify = rec.verify === true || (rec.verify !== false && (rec.navs || []).length > 0);
  if (wantVerify) {
    verifyDir = mp4.replace(/\.mp4$/, '-kockak');
    fs.mkdirSync(verifyDir, { recursive: true, mode: 0o700 });
    const totalSec = picked.length / RESAMPLE_FPS;
    const marks = [{ t: Math.min(0.3, totalSec / 2), tag: 'kezdet' }];
    (rec.navs || []).forEach((n, i) => {
      const idx = picked.findIndex((f) => f.seq > n.seq);
      if (idx >= 0) marks.push({ t: Math.min(totalSec - 0.2, idx / RESAMPLE_FPS + 1.0), tag: `nav${i + 1}` });
    });
    marks.push({ t: Math.max(0, totalSec - 0.3), tag: 'veg' });
    for (const m of marks) {
      const out = path.join(verifyDir, `${String(Math.round(m.t)).padStart(3, '0')}s-${m.tag}.jpg`);
      try {
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(m.t),
          '-i', mp4, '-frames:v', '1', '-vf', 'scale=900:-2', '-q:v', '5', out]);
        verifyFiles.push(out);
      } catch { /* egy kimaradt ellenőrző kocka nem buktathatja a felvételt */ }
    }
  }

  // ── Szakaszok a navigációk mentén ─────────────────────────────────────────────
  // Egy szakasz = két fő-keretes navigáció közötti kockák. A 0 kockás szakasz az a
  // néma hiba, amiért ez az egész könyvelés készült: a videó hossza és a teljes
  // kocka-szám ilyenkor is hibátlannak látszik.
  const navs = (rec.navs || []).slice().sort((a, b) => a.seq - b.seq);
  const bounds = [0, ...navs.map((n) => n.seq)];
  const segments = bounds.map((from, i) => {
    const to = i + 1 < bounds.length ? bounds[i + 1] : Infinity;
    const inSeg = rec.frames.filter((f) => f.seq > from && f.seq <= to);
    return {
      index: i,
      url: i === 0 ? (rec.tabUrl || null) : (navs[i - 1]?.url || null),
      frames: inSeg.length,
      // A szakasz kezdete a KÓDOLT idővonalon, hogy a verify-kocka oda essen.
      startSec: inSeg.length
        ? Math.max(0, Number((picked.findIndex((f) => f.seq === inSeg[0].seq) / RESAMPLE_FPS).toFixed(2)))
        : null,
    };
  });
  const emptySegments = segments.filter((s2) => s2.frames === 0).length;

  const wallSec = wallEnd - wallStart;
  const frameSpan = rec.frames.length > 1 ? rec.frames[rec.frames.length - 1].ts - rec.frames[0].ts : 0;

  // ── Kockaszünet-detektor (ok-független) ───────────────────────────────────────
  // A befagyott felvétel MINDIG ugyanígy néz ki, bármi okozta (lapváltás, lecsatolt
  // debugger, összeomlott renderer, rejtett fül): a kockák egy ponton elfogynak, a
  // videó hossza viszont a teljes ablakot kiteszi. Ezért nem az OKOT mérjük, hanem a
  // TÜNETET: a leghosszabb kocka-szünetet és a felvétel végén lévő néma sávot.
  // Mérve 2026-09-21: két 70 másodperces felvétel fagyott be egy SPA-ban, és az
  // akkori kimenetben (hossz, kocka-szám, fps) SEMMI nem utalt rá.
  const ordered = rec.frames.map((f) => f.ts).sort((x, y) => x - y);
  let maxGapSec = 0, maxGapAtSec = null;
  for (let i = 1; i < ordered.length; i++) {
    const g = ordered[i] - ordered[i - 1];
    if (g > maxGapSec) { maxGapSec = g; maxGapAtSec = ordered[i - 1] - ordered[0]; }
  }
  const tailGapSec = ordered.length ? Math.max(0, wallEnd - ordered[ordered.length - 1]) : wallSec;
  const result = {
    wallSec: Number(wallSec.toFixed(2)),
    frameSpanSec: Number(frameSpan.toFixed(2)),
    mp4Path: mp4, mp4Bytes: fs.statSync(mp4).size,
    gifPath: gif, gifBytes: gif ? fs.statSync(gif).size : null,
    frames: rec.frames.length, encodedFrames: picked.length,
    durationSec: Number(picked.length / RESAMPLE_FPS),
    measuredFps: wallSec > 0 ? Number((rec.frames.length / wallSec).toFixed(1)) : 0,
    sizes: [...new Set(rec.frames.map((f) => `${f.w}x${f.h}`))],
    hiddenSec: Number((rec.hiddenSec || 0).toFixed(2)),
    detachReason: rec.detachReason || null,
    crop: rec.crop || null, cropScale: rec.cropScale ?? null,
    segments, emptySegments, navCount: navs.length,
    maxGapSec: Number(maxGapSec.toFixed(2)),
    maxGapAtSec: maxGapAtSec == null ? null : Number(maxGapAtSec.toFixed(2)),
    tailGapSec: Number(tailGapSec.toFixed(2)),
    verifyDir, verifyFiles,
    quality: rec.preset, tabUrl: rec.tabUrl,
  };
  // Hiba esetén a nyers kockák MARADNAK; csak siker után takarítunk.
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

// MÉRVE: egy hibás JSON-törzs unhandled rejectiont dobott egy async handlerben, és a
// Node KILÉPETT. Futó felvétel esetén ez az egész szerver-oldali állapotot elvitte.
process.on('unhandledRejection', (e) => console.error('[edge-shot] kezeletlen elutasítás:', e));
process.on('uncaughtException', (e) => console.error('[edge-shot] kezeletlen kivétel:', e));

function parseBody(body, res) {
  try { return body ? JSON.parse(body) : {}; }
  catch { send(res, 400, { error: 'hibás JSON a kérés törzsében' }); return null; }
}

const server = http.createServer(async (req, res) => {
  try { await handleRequest(req, res); }
  catch (e) {
    console.error('[edge-shot] handler hiba:', e);
    if (!res.headersSent) send(res, 500, { error: `szerver-hiba: ${e.message}` });
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // DNS-rebinding: enélkül egy idegen lap a 127.0.0.1-re irányított hosztnévvel
  // OLVASHATÓ választ kapna a /health-től (MÉRVE: idegen Host -> 200).
  const host = (req.headers.host || '').toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
    return send(res, 403, { error: 'tiltott Host fejléc' });
  }

  if (url.pathname === '/health') {
    const age = extensionLastSeen ? Date.now() - extensionLastSeen : null;
    const live = liveBrowsers();
    // A /health szándékosan token nélkül elérhető (a CLI ebből tudja, fut-e a szerver),
    // ezért NEM adhat ki abszolút utat vagy felhasználónevet.
    const pub = {
      ok: true, port: PORT,
      extensionConnected: age !== null && age < 60_000,
      extensionLastSeenMsAgo: age, queued: queue.length,
      browsers: live,
    };
    if (tokenOk(req)) { pub.pid = process.pid; pub.outRoot = OUT_ROOT; }
    return send(res, 200, pub);
  }

  if (!tokenOk(req)) return send(res, 401, { error: 'rossz vagy hiányzó token' });

  // --- extension oldal -------------------------------------------------
  if (url.pathname === '/poll' && req.method === 'GET') {
    extensionLastSeen = Date.now();
    if (req.headers['x-browser']) browsers.set(String(req.headers['x-browser']).slice(0, 40), Date.now());
    if (queue.length) return send(res, 200, queue.shift());
    waiters.push(res);
    res.__holdTimer = setTimeout(() => {
      const i = waiters.indexOf(res);
      if (i >= 0) waiters.splice(i, 1);
      res.writeHead(204).end();
    }, POLL_HOLD_MS);
    res.on('close', () => {
      const i = waiters.indexOf(res);
      if (i >= 0) waiters.splice(i, 1);
      clearTimeout(res.__holdTimer);
    });
    return;
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    extensionLastSeen = Date.now();
    let body = '';
    for await (const c of req) body += c;
    let msg;
    try { msg = JSON.parse(body); } catch { return send(res, 400, { error: 'hibás JSON' }); }
    const slot = inflight.get(msg.id);
    if (!slot) return send(res, 200, { ok: true, note: 'a feladat már lejárt' });
    inflight.delete(msg.id);
    clearTimeout(slot.timer);
    if (!msg.ok) slot.reject(new Error(msg.error || 'ismeretlen hiba az extensionben'));
    else slot.resolve(msg);
    return send(res, 200, { ok: true });
  }

  // --- Claude oldal ----------------------------------------------------
  if (url.pathname === '/tabs' && req.method === 'GET') {
    const mb3 = jobBlocked(); if (mb3) return send(res, 409, { error: mb3 });
    try {
      const r = await enqueue({ id: randomUUID(), kind: 'tabs' });
      return send(res, 200, { tabs: r.tabs });
    } catch (e) { return send(res, 504, { error: e.message }); }
  }

  // --- felvétel-útvonalak ----------------------------------------------
  if (url.pathname === '/rec/frame' && req.method === 'POST') {
    const recId = req.headers['x-rec-id'];
    const rec = recordings.get(recId);
    // A 'starting' állapotban érkező kocka is kell: a screencast az indításkor AZONNAL küld
    // egy kockát, ami megelőzheti a recstart-választ. Mozdulatlan lapon gyakran ez az
    // EGYETLEN kocka, és eldobva „NULLA kocka" hibát adna egy hibátlan felvételre.
    if (!rec || (rec.state !== 'recording' && rec.state !== 'starting')) { req.resume(); return send(res, 200, { ok: true, drop: true }); }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    const seq = Number(req.headers['x-seq']);
    if (!Number.isFinite(seq)) return send(res, 400, { error: 'hiányzó vagy hibás x-seq' });
    const ts = Number(req.headers['x-ts']);
    // Egy NaN időbélyeg a mintavételezést és a szünet-detektort is csendben elrontaná.
    if (!Number.isFinite(ts)) return send(res, 400, { error: 'hiányzó vagy hibás x-ts' });
    const file = path.join(rec.dir, String(seq).padStart(6, '0') + '.jpg');
    fs.writeFileSync(file, buf);
    const fw = Number(req.headers['x-w']) || null;
    const fh = Number(req.headers['x-h']) || null;
    rec.frames.push({ seq, ts, file, w: fw, h: fh });

    resolveCrop(rec, fw, fh);
    if (req.headers['x-hidden-sec']) rec.hiddenSec = Number(req.headers['x-hidden-sec']);

    return send(res, 200, { ok: true });
  }

  // Szakaszhatár: a bővítmény jelzi a fő-keretes navigációt. Ebből lesz a rec-stop
  // szakaszonkénti kocka-statisztikája, ami MEGFOGJA a lapváltásnál befagyott felvételt.
  if (url.pathname === '/rec/nav' && req.method === 'POST') {
    let nbody = '';
    for await (const c of req) nbody += c;
    let nav; try { nav = JSON.parse(nbody || '{}'); } catch { return send(res, 400, { error: 'hibás JSON' }); }
    const rec = recordings.get(nav.recId);
    if (!rec || (rec.state !== 'recording' && rec.state !== 'starting')) return send(res, 200, { ok: true, drop: true });
    rec.navs.push({ seq: Number(nav.seq) || 0, url: nav.url || null, at: Date.now() });
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/rec/start' && req.method === 'POST') {
    // A törzs olvasása ELŐBB: a check és az assign közé nem kerülhet await, különben két
    // egyidejű indítás mindkettője átjut az ellenőrzésen (TOCTOU), és a második hibaága
    // kitörli az ELSŐ, élő felvétel nyilvántartását.
    let body = '';
    for await (const c of req) body += c;
    const opts = parseBody(body, res); if (!opts) return;
    const mb4 = jobBlocked(); if (mb4) return send(res, 409, { error: mb4 });
    if (activeRecId) {
      const cur = recordings.get(activeRecId);
      const what = cur?.state === 'capped'
        ? `a(z) "${cur.name}" felvétel elérte a ${REC_MAX_SEC} másodperces plafont és lezárásra vár. Add ki: shot rec-stop`
        : `már fut felvétel: ${cur?.name} (${activeRecId}) a(z) ${cur?.tabUrl || '?'} fülön, tulajdonos: ${cur?.owner || 'ismeretlen'}`;
      return send(res, 409, { error: what });
    }
    const preset = PRESETS[opts.quality || 'normal'];
    if (!preset) return send(res, 400, { error: `ismeretlen minőség: ${opts.quality}` });
    const recId = randomUUID().slice(0, 8);
    const rec = {
      recId, name: opts.name, owner: opts.session || 'anon', dir: recDir(recId),
      frames: [], navs: [], state: 'starting',
      startedAt: Date.now(), stamp: stamp(), preset: opts.quality || 'normal',
      gif: !!opts.gif, crf: opts.crf, hiddenSec: 0,
    };
    fs.mkdirSync(rec.dir, { recursive: true, mode: 0o700 });
    recordings.set(recId, rec);
    activeRecId = recId;
    try {
      const r = await enqueue({
        id: randomUUID(), kind: 'recstart', recId,
        tabId: opts.tabId, match: opts.match, selector: opts.selector,
        ...preset,
      });
      // A felvétel ablaka a screencast TÉNYLEGES indulásától számít, nem a kérés
      // beérkezésétől: a sorban állás, a fül felébresztése és a csatolás MÉRVE
      // 25 másodpercet is vihet, ami hamis hosszt adna a videónak.
      rec.startedAt = Date.now();
      rec.state = 'recording';
      // A plafon IDŐZÍTŐVEL megy: kocka-érkezésre kötve egy mozdulatlan lapon SOSEM
      // sülne el (a screencast változás-vezérelt), és a hossz is hamis lenne.
      rec.capTimer = setTimeout(() => {
        if (rec.state !== 'recording') return;
        rec.state = 'capped';
        rec.stoppedAt = Date.now();
        queue.push({ id: randomUUID(), kind: 'recstop', recId: rec.recId });
        dispatch();
      }, REC_MAX_SEC * 1000);
      rec.tabId = r.tabId;
      rec.tabUrl = r.tabUrl;
      rec.cssRect = r.cssRect || null;
      rec.geometry = r.geometry;
      const early = rec.frames.find((f) => f.w);
      if (early) resolveCrop(rec, early.w, early.h);
      return send(res, 200, { ok: true, recId, ...r, preset: rec.preset });
    } catch (e) {
      recordings.delete(recId);
      if (activeRecId === recId) activeRecId = null;
      fs.rmSync(rec.dir, { recursive: true, force: true });
      return send(res, 502, { error: e.message });
    }
  }

  if (url.pathname === '/rec/stop' && req.method === 'POST') {
    let sbody = '';
    for await (const c of req) sbody += c;
    const sopts = parseBody(sbody, res); if (!sopts) return;
    if (!activeRecId) return send(res, 409, { error: 'nem fut felvétel' });
    const rec = recordings.get(activeRecId);
    // Két egyidejű stop különben KÉTSZER kódolna ugyanabba a fájlba, miközben az első
    // már törölte a nyers kockákat.
    if (rec.state !== 'recording' && rec.state !== 'capped') {
      return send(res, 409, { error: `a felvétel állapota már "${rec.state}", nem állítható le újra` });
    }
    // Idegen session ne állíthassa le más felvételét: a leállító kapná meg a fájlt, a
    // tulajdonos pedig „nem fut felvétel" hibát, pedig a videója elkészült.
    const who = sopts.session || 'anon';
    if (rec.owner !== who && !sopts.force) {
      return send(res, 409, { error: `a felvételt "${rec.owner}" birtokolja (te: "${who}"). Ha tényleg le akarod állítani: shot rec-stop --force` });
    }
    rec.state = 'stopping';
    if (typeof sopts.verify === 'boolean') rec.verify = sopts.verify;
    if (rec.capTimer) { clearTimeout(rec.capTimer); rec.capTimer = null; }
    if (!rec.stoppedAt) rec.stoppedAt = Date.now();
    try {
      const sres = await enqueue({ id: randomUUID(), kind: 'recstop', recId: rec.recId });
      // Ha a fül a stopig rejtve maradt, nem jött több kocka, tehát a fejlécben utazó
      // hiddenSec elavult: a leállítás eredménye a friss érték.
      if (sres && typeof sres.hiddenSec === 'number') rec.hiddenSec = sres.hiddenSec;
      if (sres && sres.detachReason) rec.detachReason = sres.detachReason;
    } catch (e) {
      // A leállítás elbukhat (elhalt worker), de a lemezen lévő kockákból még kódolunk.
      rec.stopError = e.message;
    }
    activeRecId = null;
    rec.state = 'encoding';
    if (!rec.frames.length) {
      fs.rmSync(rec.dir, { recursive: true, force: true });
      rec.state = 'failed';
      return send(res, 502, { error: 'NULLA kocka érkezett. A fül nem renderelt (háttérbe került, vagy semmi nem változott a lapon). Nem gyártok üres videót.' });
    }
    try {
      const out = await encode(rec);
      rec.state = 'done';
      rec.frames = [];  // a kocka-lista elszabadulna a memóriában több felvétel után
      return send(res, 200, { ok: true, recId: rec.recId, stopError: rec.stopError || null, ...out });
    } catch (e) {
      rec.state = 'failed';
      return send(res, 500, { error: `kódolás elbukott: ${e.message}. A nyers kockák megmaradtak: ${rec.dir}` });
    }
  }

  if (url.pathname === '/rec/status' && req.method === 'GET') {
    const rec = activeRecId ? recordings.get(activeRecId) : null;
    return send(res, 200, {
      active: !!rec,
      recId: rec?.recId ?? null, name: rec?.name ?? null, state: rec?.state ?? null,
      owner: rec?.owner ?? null, tabId: rec?.tabId ?? null, tabUrl: rec?.tabUrl ?? null,
      frames: rec?.frames.length ?? 0,
      elapsedSec: rec ? Number(((Date.now() - rec.startedAt) / 1000).toFixed(1)) : null,
      hiddenSec: rec?.hiddenSec ?? null, maxSec: REC_MAX_SEC,
      orphanDirs: fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('edge-shot-rec-')),
    });
  }

  if (url.pathname === '/probe' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const pb = parseBody(body, res); if (!pb) return;
    const job = { ...pb, id: randomUUID(), kind: 'probe' };
    const mb2 = jobBlocked(); if (mb2) return send(res, 409, { error: mb2 });
    // A szondázás nem hozza előre a fület (executeScript háttérben is fut), ezért egy
    // futó felvételt nem zavar: nincs mit tiltani.
    try { return send(res, 200, await enqueue(job)); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }

  // Szöveg kép helyett. Nem hoz előre fület, ezért felvétel alatt is szabad.
  if (url.pathname === '/text' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const tb = parseBody(body, res); if (!tb) return;
    const mbt = jobBlocked(); if (mbt) return send(res, 409, { error: mbt });
    try { return send(res, 200, await enqueue({ ...tb, id: randomUUID(), kind: 'text' })); }
    catch (e) { return send(res, 502, { error: e.message }); }
  }

  if (url.pathname === '/reload' && req.method === 'POST') {
    if (activeRecId || inflight.size) {
      const cur = activeRecId ? recordings.get(activeRecId) : null;
      return send(res, 409, { error: cur
        ? `nem töltöm újra: felvétel fut ("${cur.name}", tulajdonos ${cur.owner}). Az újratöltés megölné.`
        : `nem töltöm újra: ${inflight.size} feladat fut éppen (másik session).` });
    }
    try {
      await enqueue({ id: randomUUID(), kind: 'reload' });
      return send(res, 200, { ok: true });
    } catch (e) { return send(res, 504, { error: e.message }); }
  }

  if (url.pathname === '/shot' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let job;
    try { job = JSON.parse(body); } catch { return send(res, 400, { error: 'hibás JSON' }); }
    const mb = jobBlocked(); if (mb) return send(res, 409, { error: mb });
    const block = recordingBlock(job.tabId, 'fotózás');
    if (block) return send(res, 409, { error: block });
    job.id = randomUUID();
    job.kind = 'shot';
    job.jpegMaxPx = JPEG_MAX_PX;
    job.jpegQuality = JPEG_QUALITY;
    try {
      const r = await enqueue(job);
      const saved = await persist(job, r.dataUrl, r);
      return send(res, 200, { ok: true, mode: job.mode || 'viewport', barPx: r.barPx ?? null, scaleUsed: r.scaleUsed ?? null, ...saved });
    } catch (e) { return send(res, 502, { error: e.message }); }
  }

  return send(res, 404, { error: 'ismeretlen útvonal' });
}

server.on('error', (e) => {
  console.error(`[edge-shot] a szerver nem tud elindulni: ${e.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`edge-shot server: http://127.0.0.1:${PORT} (pid ${process.pid}) → ${OUT_ROOT}`);
});
