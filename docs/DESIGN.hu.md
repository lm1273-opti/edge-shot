# edge-shot — design

*2026-09-14. Állapot: implementálva és végponttól végpontig mérve.*

## A probléma

Bejelentkezett böngészőből képi bizonyítékot fájlba kinyerni ma három kerülőúton megy
(`claude-in-chrome` → `gif_creator`):

- a kimenet **GIF**, 256 színnel — a UI-szöveg elmosódik;
- a fájl `~/Downloads`-ba esik **kiterjesztés nélkül**, így `*.png` mintára nem található;
- csak **interakcióra** rögzül kocka, tehát egy állóképhez is ki kell találni egy
  ártalmatlan kattintást, majd `ffmpeg`-gel bontani és `sips`-szel vágni.

Egy állókép így 6–8 lépés, és a végeredmény rosszabb minőségű, mint a forrás.

## A megoldás alakja

```
Claude ──curl──▶ server.mjs (127.0.0.1:8765) ◀──long-poll── Edge extension
                      │                                          │
                      │                              chrome.debugger / tabs
                      ▼                                          ▼
        ~/.claude/screenshots/<nap>/                     a bejelentkezett fül
           <idő>-<név>.png   veszteségmentes, 2×
           <idő>-<név>.jpg   ~15 KB, artifactba
```

### Miért loopback szerver, és nem native messaging

A native messaging manifestjébe **az extension ID kell**, amit csak a betöltés *után*
kapsz meg — tyúk-tojás telepítés, profilonként megismételve. A loopback szerver ezzel
szemben `curl`-lel debugolható, és az extension *kifelé* csatlakozik hozzá, tehát nincs
CORS- vagy engedély-bonyodalom.

### Miért long-poll, és nem WebSocket

A WebSocket kézi keretezése node-ban ~100 sor függőség nélkül. A long-poll ugyanazt adja
HTTP-vel: a szerver **25 másodpercig** tartja a `/poll` választ (az MV3 service worker
30 s-os tétlenségi korlátja alatt), majd 204-gyel elengedi, és az extension azonnal
újrakérdez. Minden válasz egy esemény, ami nullázza a leállási számlálót.

**MÉRVE 2026-09-14: a kockázat nem áll fenn.** 10 percen át, 30 másodpercenként mintavételezve
mind a 20 mérés csatlakozott állapotot mutatott, az utolsó poll kora 21 és 28 másodperc között
ingadozott (pontosan a 25 s-os tartás ritmusa), és a 10. perc után kiadott élő fotó-kérés
azonnal teljesült. Az offscreen document tartalékra nem volt szükség.

Az eredeti megfogalmazás, a teljesség kedvéért: ez volt a rendszer egyetlen valódi kockázata. Ha a service worker mégis elhal, a tartalék
egy *offscreen document* (az nem service worker, nem jár le). A hibamód addig is szelíd:
a `shot health` kimondja, hogy „a szerver fut, de az extension nincs csatlakozva", és egy
kattintás a bővítmény ikonján azonnal újraindítja a ciklust. Hálóként `chrome.alarms`
percenként is meghívja a ciklust.

### A négy mód

| Mód | Mechanizmus | Miért így |
|---|---|---|
| `viewport` | `Page.captureScreenshot` | (A terv eredetileg `tabs.captureVisibleTab`-ot írt; a mérési napló szerint az az ág TÖRÖLVE, mert nem a kért fület adja. Mind a négy mód egyetlen debugger-úton megy.) |
| `fullpage` | `Page.captureScreenshot{captureBeyondViewport:true}` | **Egy darabban** rendereli a teljes lapot — nincs görgetés-összefűzés, nincs illesztési varrat. |
| `element` | ugyanaz, `clip`-pel, a rect-et `scripting.executeScript` adja | Elveszi a kézi `sips --cropOffset` lépést, és a koordináta a *dokumentum* origójához képest megy, tehát görgetéstől független. |
| `mobile` | `Emulation.setDeviceMetricsOverride` + touch + UA | Valódi mobil renderelés DPR 3-mal, nem CSS-átméretezés. |

A nem-viewport módoknál mindig explicit `setDeviceMetricsOverride` megy (alapból
`deviceScaleFactor: 2`), hogy a kimenet felbontása **determinisztikus** legyen, ne a
fizikai képernyőtől függjön.

## Biztonság

A szerver csak `127.0.0.1`-re bindol, és a `/health`-en kívül minden útvonal
telepítéskor generált tokent kér. A token KÉT fájlban él, mindkettő `600`-as jogokkal és
`.gitignore`-ban: `config.json` (a szerveré) és `extension/config.js` (a bővítményé).
Enélkül bármelyik helyi
folyamat fotózhatná a bejelentkezett fület.

## Szándékosan kihagyva (YAGNI)

Felugró UI, beállítás-oldal, annotáció. **A videó azóta megvalósult** (lásd a videó-szekciót),
tehát ez a pont már csak az eredeti hatókört rögzíti. A `gif_creator`-os út érintetlenül
megmarad, de a gyakorlatban nincs rá szükség.

## Ismert korlátok

- Az `edge://` és bővítménybolt-lapok nem fotózhatók (böngésző-korlát).
- Elem-mód nem néz bele `iframe`-be (a `querySelector` a fő dokumentumon fut).
- A `Claude_Browser` (in-app) fülét nem látja — az külön böngésző.


---

# Mérési napló (2026-09-14)

Minden alábbi állítás **futtatással** igazolt, nem kódolvasásból következtetve.

## Ami az első futásra megdőlt

| Feltevés | Mi történt valójában |
|---|---|
| „Háttér-fül is fotózható" | A `Page.captureScreenshot` **örökké vár** egy nem renderelt fülön (90 s időtúllépés). A headed Chromium nem komponál keretet háttér-fülnek. **Javítás:** a célfület aktiváljuk, utána visszaállítjuk a korábbit. |
| „`captureVisibleTab` a gyors út viewporthoz" | Nem a **kért** fület adja, hanem az ablak épp látható fülét — a `--tab` néma hazugság lett volna. Engedélyhibán bukott ki. **Javítás:** az ág törölve, mind a négy mód egyetlen debugger-úton megy. |
| „A beragadt service worker felébred magától" | 110 s polling alatt **végig `false`**. A régi kód egy soha vissza nem térő callbackre várt, a `looping` flag igaz maradt, az ébresztő azonnal visszafordult. **Javítás:** 20 s parancs-időkorlát, 60 s feladat-időkorlát, és őrkutya, ami 90 s néma ciklus után `chrome.runtime.reload()`-ol. |
| „A fül biztosan renderel" | Az Edge **„alvó fülek"** funkciója eldobja a régi fülek rendererét; a `debugger.attach` sikerül, de a `Page.enable` elakad. **Javítás:** `wakeTab()` — újratöltés és várakozás `status: complete`-ig. |
| „`sips -Z 1200` jó az artifact-ikerhez" | A `-Z` a **leghosszabb** oldalt korlátozza. Egy 1125×19899-es teljes lapnál a JPEG **68×1200** lett — használhatatlan szilánk, miközben a kimenet „23 KB"-ot jelentett. **Javítás:** `--resampleWidth`, csak ha a forrás szélesebb a korlátnál. |

## Ami igazolódott

| Állítás | Bizonyíték |
|---|---|
| A debugger sárga sávja nem kerül a képbe | A builder-viewport képen sehol nincs értesítő sáv. |
| `fullpage` valóban a teljes dokumentumot adja, egy darabban | GitHub-lap: **8054 px** vs. viewport **1730 px**, varrat nélkül. |
| `element` pontosan az elemet vágja | `article.markdown-body`: **1724 px széles** a lap 3184 helyett. |
| A mobil-emuláció valódi | 375×844 @ DPR 3 → 1125×2532, hamburger menü, mobil breakpoint — nem CSS-átméretezés. |
| A mobil és a fullpage kombinálható | 1125×19899. |
| Minden hibaút beszédes | „nem talált elemet", „hibás selector", „Cannot access edge:// URLs", „a fül nem ébredt fel". |

## Menet közben hozzáadva

- **`shot probe --selector`** — megmondja, mit talál egy selector és mekkora. Enélkül az
  elem-mód tippelés (a GitHub `#readme`-je például már nem létezik).
- **`shot reload`** — a bővítmény forró újratöltése, hogy a kódváltozáshoz ne kelljen
  kézi kattintás az `edge://extensions` alatt.
- **Méret-figyelmeztetés** 400 KB fölött, a base64-becsléssel együtt.
