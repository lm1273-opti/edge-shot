# edge-shot — design

*Magyar nyelvű tervezési és mérési napló. A használati dokumentáció a repó gyökerében lévő
angol `README.md`.*

*Első kiadás: 2026-09-14. Utolsó frissítés: 2026-09-15.*

A napló azért van így felépítve, hogy látszódjon, **mit hittem és mit mért a valóság**. A
későbbi körök ugyanezt a formát követik: minden szakasz külön jelöli, mi bizonyított
futtatásból, és mi maradt következtetés.

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


---

# 2. kör (2026-09-15) — videó

A cél: eseménysort rögzíteni, amit két állóképpel nehéz megmutatni.

## Az eredeti terv, ami MÉRÉSEN dőlt meg

| Feltevés | Mit mutatott a mérés |
|---|---|
| „Másodpercenként 24 képet készítünk és összefűzzük" | Nem járható: egy kocka ~1 MB PNG, körutazásonként. Helyette `Page.startScreencast`, ami folyamatosan tolja a JPEG-kockákat. |
| A felvétel egy feladat lehet | **Nem.** A bővítményben 60 s-os feladat-korlát és 90 s-os őrkutya van, és amíg egy feladat fut, a ciklus nem pollozik, tehát a leállítás sem jutna át. A start és a stop két RÖVID feladat, a felvétel a cikluson kívül él. |
| A kockasebességet ejtéssel korlátozzuk | A **nyugtázás késleltetése** fékez, és a böngésző nem is gyártja a fölösleges kockát. Mérve: ack 0 ms → 90 kocka/mp, 40 → 57, 100 → 27, 200 → 14. |
| A vágás szorzója a device pixel ratio | **`frameW / deviceWidth`.** Mérve 0,714 (maxWidth 1280) és 0,502 (maxWidth 900); a DPR 2 lenne, azaz 2,8-szeres tévedés. A kocka pixelmérete csak az első kockából derül ki, és ingadozik (1262×686 vs 1280×664 ugyanazon a lapon). |
| Az ffmpeg `concat` demuxer jó időzítést ad | **Hamis hossz:** 4,5 s helyett 2,56 s (az utolsó `duration` elvész). Helyette fix 30 fps-re mintavételezünk, ami pontosan 4,500000 s-ot ad. |
| A képméret bármi lehet | Páratlan méret + `yuv420p` → **0 bájtos fájl**, néma bukás. A vágás páros-kényszerítése a szűrőben van. |

## A hossz FAL-ÓRA alapú, nem a kocka-ív

Élőben elkövetett hiba: statikus lapról 1 kocka jön, a kocka-ív 0 mp, és egy „sikeres"
**0 másodperces** videó keletkezett 5 mp kérés helyett. A kapu nulla kockát őrzött, de 1 kocka
nem nulla — **a kapu rossz mennyiséget nézett**.

## Igazolt valós idejűség

A rögzített lap saját másodperc-számlálója a videó 0,5. és 5,5. másodperce között
**5,02 másodpercet** lépett. Ezt rontotta volna el a concat-módszer.

## Nyitott, NEM megmagyarázott

Navigáció felvétel közben 3-ból 2 futásban helyesen látszik, 1-ben a videó a navigáció
előtti lapot mutatta a végén. Lapváltásos felvételt nézz meg, mielőtt bizonyítékként
használod.

---

# 3. kör (2026-09-15) — több párhuzamos session

Alapmérés: 3 párhuzamos session 3 fülön, 3/3 körben mindenki a **saját lapját** kapta (a
fájlok tartalmából visszaazonosítva). A feladat-sor sorosít, tehát fotózásnál nincs fül-verseny.

Négy NÉMA hiba, amit ez feltárt:

1. **Fájlnév-ütközés.** Két session, azonos másodperc, azonos név → ugyanaz az út, néma
   felülírás, mindkettő „OK". Javítás: atomi `wx` névfoglalás, `-2`/`-3` toldalék.
2. **TOCTOU a felvétel-indításnál.** A check és az assign közt `await` állt, így két
   egyidejű indítás mindkettője átjutott, és a második hibaága törölte az ELSŐ, élő felvétel
   nyilvántartását.
3. **A lejárt feladat a sorban maradt**, és később „szellem-feladatként" lefutott: fület
   rántott elő idegen felvétel alatt, vagy elindított egy felvételt, amiről a szerver már
   nem tudott.
4. **A `probe` előhozta a fület és sosem állította vissza** — egy harmadik session
   szondázása befagyasztotta a futó videót.

**A helyes tiltó-szabály** felvétel alatt nem „semmi más nem mehet", hanem: *a felvett
fültől ELTÉRŐ fület nem szabad előhozni*. Ugyanarra a fülre a szondázás engedett (nem
csatol), a fotózás nem (a debugger már csatolva van).

---

# 4. kör (2026-09-15) — bármelyik Chromium böngésző

A capture-kód eleve hordozható volt: mind a 36 hívás a szabványos `chrome.*` névtérben megy.
Ami Edge-specifikus volt, az a szöveg és a telepítő.

**Amit a Chrome-támogatás BEHOZOTT:** ha a bővítmény két böngészőbe is be van töltve,
mindkettő ugyanazt a szervert pollozza, és a feladat-kiosztás nem tudja, melyikről van szó.
Mivel a fül-azonosítók böngészőnként mások, egy `--tab 42` a **rossz böngésző** egy létező
fülét fotózhatná le — helyesnek látszó képpel.

Megoldás: nem okos útválasztás, hanem **tiszta elutasítás**. A bővítmény minden pollnál
megmondja, melyik böngészőben fut; amíg kettő csatlakozik, a szerver megnevezi mindkettőt és
nem dolgozik. A bejegyzés 60 mp után elévül, tehát egy eltűnt böngésző nem blokkol örökre.

---

# 5. kör (2026-09-15) — publikálás előtti megerősítés

Két független review (egy általános és egy kifejezetten biztonsági) leletei, mind javítva:

| Hiba | Következmény |
|---|---|
| **Bármilyen hibás JSON megölte a szervert** | Futó felvétel esetén az egész szerver-oldali állapot elveszett |
| **A `--tab 12a` némán az AKTÍV fület fotózta** | Helyes kép, rossz lapról — a legrosszabb hibaosztály |
| **A `/health` token nélkül kiadta a felhasználónevet és az abszolút utat** | Információ-szivárgás egy hitelesítés nélküli útvonalon |
| **Idegen `Host` fejlécre válaszolt** | DNS-rebinding: egy weblap elérhette a loopback szervert |
| **A kimeneti fájlok 644-esek voltak** | Közös gépen bárki elolvashatta a bejelentkezett fülről készült képet |
| **A `EDGE_SHOT_PORT` validálatlanul került a bővítmény kódjába** | Tetszőleges JS becsempészhető egy `debugger` jogú service workerbe |
| **A `$ROOT` JS-stringbe interpolálva a telepítőben** | Aposztrófot tartalmazó klón-útvonal = JS-injekció |
| **A vágás-kapu az ffmpeg UTÁN dobott** | A hibaüzenet azt állította, hogy nincs vágatlan videó, miközben az már a lemezen volt |

Az utolsó a saját, előző körben bevitt javításom mellékhatása volt: **egy hibaüzenet, ami
mást mond, mint ami a lemezen van, rosszabb, mint maga a hiba.**

Igazolt támadási utak, mind zárva: útvonal-kiszökés a fájlnéven át (`../../../../tmp/evil`
→ `tmp-evil`), ffmpeg-flag-injekció (`-rf` → `rf`), shell-metakarakterek, token a
parancssorban (nem: fejlécben megy), selector-injekció (adatként megy a page-scriptbe).

---

# 6. kör (2026-09-15) — a telepítő

Cél: ember és AI-ügynök is végig tudja vinni, utóbbi terminál nélkül.

- Minden kérdésnek van kapcsolója (`--yes`, `--no-skill`), `--json` gépileg olvasható
  összefoglalóval, és megkülönböztetett kilépési kódok (2 használat, 3 node, 4 port,
  5 sérült config, 6 nincs böngésző).
- Az újrafuttatás explicit idempotens: a meglévő `config.json` **tokenje ÉS portja** marad,
  hogy a két konfigurációs fájl sose divergáljon.
- **A skill soha nem települ némán.** Egy skill olyan prompt, ami egy AI-ügynök viselkedését
  módosítja, tehát a legnagyobb bizalmi lépés a telepítésben: interaktívan kérdez, nem
  interaktívan kihagyja, és megmondja, mivel telepíthető utólag.
