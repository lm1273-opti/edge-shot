# edge-shot

Lossless screenshots and real-time screen recordings from **the browser you are already
signed into**, straight to disk, driven from the command line or from an AI coding agent.

Works with any Chromium browser: **Edge, Chrome, Chromium, Brave**. The installer picks
whichever you have (Edge first, then Chrome) and prints the right instructions. The name
comes from where the project started, not from a requirement.

It exists because the usual ways of getting a picture out of a signed-in browser are bad:
a GIF recorder gives you 256 colours and blurred UI text, "save to disk" often saves nothing,
and stitching a full page together leaves seams. `edge-shot` asks the browser itself, over the
DevTools protocol, and writes a real PNG.

```bash
shot dashboard --tab 42                       # visible area
shot whole-page --tab 42 --mode fullpage      # entire document, in one piece, no seams
shot the-modal --tab 42 --mode element --selector ".modal"
shot on-mobile --tab 42 --mobile 375          # real mobile rendering, not a CSS resize
shot bug-report --tab 42 --url                # adds a white bar with the page URL on top

shot rec-start flow --tab 42 --quality high   # record an event sequence
#   … drive the page however you like …
shot rec-stop                                 # -> real-time MP4
```

## Why it might be useful to you

- **It photographs the session you are already signed into.** No separate automated browser, no
  re-authentication, no cookie export.
- **The output is evidence-grade.** Lossless PNG at 2x device pixel ratio, so small UI text stays
  readable; an artifact-sized JPEG twin is written next to it for embedding.
- **It can record.** When the defect is a sequence rather than a state, `rec-start` / `rec-stop`
  produces an MP4 whose timing is real: three seconds on screen are three seconds on the video.
- **Several agent sessions can share one browser**, each on its own tab, without silently
  overwriting each other's files.

## Requirements

- A Chromium browser that can load an unpacked MV3 extension: Edge, Chrome, Chromium or Brave
- Node.js 18 or newer
- Nothing platform-specific: the downscaled JPEG twin is made by the extension itself
- `ffmpeg` on your PATH, only if you want video

## Install

```bash
git clone https://github.com/lm1273-opti/edge-shot.git
cd edge-shot
./install.sh
```

The installer checks for Node.js 18+, generates a private token, writes the two config
files (`config.json` and `extension/config.js`, both mode `600`), asks whether to install
the Claude skill, and then prints the one step that cannot be automated: loading the
extension into your browser. Re-running it is safe: an existing `config.json` keeps its
token and port.

### Non-interactive install (agents, CI)

Every question has a flag, so the script runs to completion without a terminal:

```bash
./install.sh --yes --json          # install the skill too, machine-readable summary
./install.sh --no-skill --json     # never install the skill
./install.sh --help                # every flag, variable and exit code
```

| Flag / variable | Effect |
|---|---|
| `-y`, `--yes` or `EDGE_SHOT_ASSUME_YES=1` | Answer yes to every question (installs the Claude skill). Without it, a non-interactive run skips the skill: it is a prompt that changes an agent's behaviour, so it is never installed silently. |
| `--no-skill` | Never install the skill (wins over `--yes`). |
| `--json` | Print a JSON summary on stdout (`status`, `port`, `browser`, `extensionDir`, `skill`, `manualStep`, …); notes go to stderr. Implies non-interactive. |
| `EDGE_SHOT_PORT=8765` | Server port, 1–65535. Ignored once `config.json` exists (its stored port is kept). |
| `EDGE_SHOT_BROWSER=Chrome` | `Edge`, `Chrome`, `Chromium` or `Brave`; overrides detection. |

Exit codes: **0** installed or already installed (`"status"` in the JSON says which) ·
**2** usage error · **3** `node` missing or older than 18 · **4** invalid port ·
**5** existing `config.json` unreadable or without a token ·
**6** configs written but no Chromium browser found (set `EDGE_SHOT_BROWSER`).

### Loading the extension

This is a normal "unpacked extension" install. It takes about thirty seconds and you only
do it once.

**1. Open the extensions page.** Type the address in the address bar; it will not appear in
a normal search.

| Browser | Address |
|---|---|
| Edge | `edge://extensions` |
| Chrome | `chrome://extensions` |
| Brave | `brave://extensions` |
| Chromium | `chrome://extensions` |

**2. Turn on Developer mode.** This is the step people miss, and without it the button you
need in step 3 does not exist at all. It is a toggle switch labelled **Developer mode** —
but the two browsers put it in different corners:

```
EDGE                                  CHROME
┌────────────────┬──────────────────┐ ┌─────────────────────────────────────┐
│                │                  │ │  Extensions            [Developer ●]│  <- top RIGHT
│  Extensions    │   your           │ ├─────────────────────────────────────┤
│  ...           │   extensions     │ │ [Load unpacked] [Pack] [Update]     │
│                │                  │ │                                     │
│ [Developer ●]  │                  │ │   your extensions                   │
└────────────────┴──────────────────┘ └─────────────────────────────────────┘
   ^ bottom LEFT of the sidebar
```

Once the toggle is on, a new row of buttons appears: **Load unpacked**, **Pack extension**,
**Update**. If you do not see them, the toggle is still off.

> Your browser's interface may be in another language; look for the toggle in the corner
> shown above rather than for the exact English words.

**3. Click "Load unpacked"** and select the **`extension/` folder inside this repository** —
the folder itself, not a file inside it, and not the repository root. The installer prints
the exact absolute path; copy it into the folder picker.

A card titled **edge-shot** should now appear in the list. If the browser shows a warning
about extensions in developer mode, that is expected for any unpacked extension and can be
dismissed; the extension keeps working.

**4. Verify.**

```bash
./shot health
```

`extensionConnected` should be `true` and `browsers` should name your browser. If it is
`false`, click the extension's icon in the toolbar once to wake its service worker, and
try again.

### After a browser restart

Nothing to do: the extension loads itself and reconnects. If you ever pull a new version of
this repository, click the **reload** (↻) icon on the extension's card, or run
`./shot reload`, which refuses to reload source that does not compile.

### One browser only

Load it into **one** browser. Tab ids are per-browser, so a second copy would make
`--tab 42` ambiguous; the server notices two browsers connected and refuses to work rather
than guessing, because a capture from the wrong browser would look perfectly correct.

To pick the browser yourself, set `EDGE_SHOT_BROWSER=Chrome` before running the installer.

Then check it:

```bash
./shot health
```

The local server starts itself on demand; there is nothing to run in the background.

## Command reference

```bash
shot health                      # is the server up, which browser is connected
shot tabs                        # open tabs: id, title, URL
shot probe --selector "<css>"    # what a selector matches, and how big
shot check                       # does the extension source compile
shot reload                      # reload the extension after changing its code
shot rec-status                  # is a recording running, how many frames so far
shot join <name> --clip a.mp4::"BEFORE" --clip b.mp4::"AFTER"   # clips into one video
shot --help                      # everything below, from the tool itself
```

> The CLI's own messages and its `--help` are currently in Hungarian. The tables below say
> the same thing in English; the flags themselves are of course the same.


**Stills.** The first argument is the file name:

```bash
shot <name> [--tab <id> | --match <text>] [options]
```

| Option | Meaning |
|---|---|
| `--mode viewport` | The visible area (default) |
| `--mode fullpage` | The whole document in one piece, no scrolling seams |
| `--mode element --selector "<css>"` | Just that element; `--padding <px>` adds a margin |
| `--mobile [width]` | Mobile emulation at that CSS width (default 390), device pixel ratio 3 |
| `--url` | Adds a white bar on top carrying the page URL, for tickets that want it visible |
| `--scale 1-4` | Device pixel ratio of the output (default 2) |
| `--settle <ms>` | Wait before capturing, up to 10000, for pages that animate in |
| `--session <id>` | Who you are; see the concurrency note below |

**Video.**

```bash
shot rec-start <name> [--quality low|normal|high] [--selector "<css>"] [--gif]
#   … drive the page …
shot rec-stop [--force] [--verify | --no-verify]
shot rec <name> --seconds 1-120  # fixed length, start and stop in one command
```

`rec-stop` does not just hand you a file, it tells you whether the file is worth trusting:

| It prints | What it means |
|---|---|
| `FIGYELEM: az utolsó N másodpercben NEM érkezett kocka` | No frames arrived for the last N seconds. The video ends on a frozen picture even though its duration is complete. |
| `FIGYELEM: N másodperces kocka-szünet` | The same gap, but in the middle of the recording. |
| `SZAKASZOK` table | One row per main-frame navigation, with the frame count and URL of each stretch. A row with zero frames gets its own warning. |
| `FIGYELEM: a debugger lecsatolódott` | The debugger detached mid-recording; the extension retries the attach up to three times, but part of the recording may be missing. |
| `ELLENŐRZŐ KOCKÁK` | Still frames extracted from the finished video: the start, one after each navigation, and the end. Look at them before you call the video evidence. |

Verification stills are written automatically when the recording contains a navigation.
`--verify` forces them, `--no-verify` turns them off.

**Joining clips.** A long scene is more reliable as several short clips than as one long
recording: a spoiled stretch can be re-recorded on its own, and a mistake shows up
immediately. `shot join` stitches them back together with a header bar per clip, so a
viewer can tell which half is which.

```bash
shot join before-after \
  --clip 1203-before.mp4::"BEFORE · main" \
  --clip 1214-after.mp4::"AFTER · the fix"
```

A label starting with `BEFORE`/`ELŐTTE` gets a red strip, `AFTER`/`UTÁNA` a green one.
The command also writes a still from the end of each section, for the same reason as above.
Drawing the bar needs `python3` with Pillow, because many ffmpeg builds ship without
`drawtext`; the command says so plainly if it is missing.

Every capture writes a lossless PNG plus a width-capped JPEG twin (or an MP4) into
`~/.claude/screenshots/<date>/`, and prints both paths, the pixel size, and the title and
URL of the tab it photographed. Use those last two when you describe the image: they are
what makes a caption checkable.

## Which browser am I actually driving?

Whichever one you loaded the extension into. You do not pick per command, and you do not
have to remember: `shot health` tells you.

```console
$ shot health
{
  "ok": true,
  "port": 8765,
  "extensionConnected": true,
  "browsers": ["Edge"]
}
```

If `browsers` lists **two**, every command is refused until you remove one copy, and the
error names both browsers.

That refusal is deliberate. Guessing here would produce a screenshot that is sharp,
correctly named, and of the wrong page — the one failure mode this tool exists to avoid.
An entry expires 60 seconds after that browser stops polling, so closing one browser
unblocks things on its own.

## How it works

```
CLI ──POST──▶ server (127.0.0.1) ◀──long-poll── browser extension
                   │                                  │
                   │                        chrome.debugger / tabs
                   ▼                                  ▼
            your screenshots dir                 your logged-in tab
```

The extension connects **outward** to a loopback-only server, so there is no inbound port to
open and no browser permission dance. Captures go through the DevTools protocol, which is what
makes full-page, element-clipped and mobile-emulated shots possible from one code path.

## Recording quality presets

Frame rate is limited by **delaying the frame acknowledgement**, so the browser never
generates frames that would be thrown away. Measured on a continuously animating page,
five-second clips:

| preset | JPEG | max width | measured fps | size |
|---|---|---|---|---|
| `low` | 45 | 900 px | 11.4 | 42 KB |
| `normal` (default) | 70 | 1400 px | 27.0 | 73 KB |
| `high` | 85 | 1800 px | 61.3 | 94 KB |

Timing is real: on a page carrying its own on-screen clock, the counter advanced by
**5.02 seconds** between the 0.5s and 5.5s marks of the video.

## Things worth knowing (all measured, not assumed)

- **The tab you photograph comes to the front**, then the previous one is restored. A headed
  browser does not render a background tab, so there is nothing to capture until it is visible.
  You will see a flash. That is not a bug.
- **A recording freezes if its tab loses focus**, for the same reason. While a recording runs,
  the tool refuses to photograph a *different* tab and tells you who is recording and where.
- **A static page produces almost no frames**, because the screencast is change-driven. The
  recording is still the right length, but it is effectively a still image, and the tool says so.
- **A recording's duration proves nothing; its frames do.** A recording that froze part way
  through still has the full duration, a believable frame count and a believable frame rate.
  Measured on 2026-09-21: two 70-second recordings froze in the middle and nothing in the
  output said so; only a frame pulled out with ffmpeg showed it. The tool now measures the
  symptom rather than guessing the cause, because the symptom is always the same whatever
  stopped the frames: it reports any gap longer than three seconds, and the frame count of
  each stretch between navigations. Falsified both ways: a deliberately stopped page reported
  `az utolsó 24,06 másodpercben NEM érkezett kocka`, and healthy recordings stayed silent.
- **Full-page mode can equal viewport mode** in apps that scroll inside an inner container. That
  is correct behaviour; use element mode on the scrolling container instead.
- **The browser's own pages** (`edge://…`, `chrome://…`) cannot be captured. Browsers
  forbid extensions from reading them; this is not something the tool can work around.

## Portability

Written and measured on macOS with Edge 153 and Node 26. Elsewhere:

- **Linux / Windows**: everything works, including the downscaled JPEG twin, which the
  extension renders itself (an extension that was not reloaded since falls back to the
  macOS `sips` tool, and the capture command says so).
- **Any Chromium browser**: the extension uses the standard `chrome.*` APIs, so Edge, Chrome,
  Chromium and Brave all work identically; only the extensions-page address differs, and the
  installer prints the right one. `shot health` reports which browser is actually connected.
- **Port in use**: `EDGE_SHOT_PORT=9000 ./install.sh` writes the port into both config
  files. Re-running the installer keeps whatever port is already configured.
- **Tab ids change** when the browser restarts, so never store a `--tab` value; run
  `shot tabs` again.

## Troubleshooting

> **Note on language:** the CLI currently prints its messages in Hungarian. The table below
> describes the situations rather than quoting the exact strings, so it stays true either way.

| Situation | What it means |
|---|---|
| The extension is reported as not connected | The browser is not running, or its service worker was stopped. Click the extension's toolbar icon once to wake it. After restarting the server, reconnection can take up to a minute. |
| Two browsers are reported as connected | The extension is loaded into more than one browser; every command is refused until one copy is removed. See above. |
| `--match` is refused with a list of tabs | The pattern was ambiguous. Use one of the `--tab <id>` values it prints. Refusing beats silently picking the wrong tab. |
| A selector matched nothing | Run `shot probe --selector "…" --tab <id>`. The element may be inside an iframe (the query runs on the main document) or not rendered yet (`--settle 1500`). |
| A capture is refused because a recording is running | A recording holds its tab in the foreground; bringing another tab forward would freeze it. Wait, or `shot rec-stop`. |
| `shot reload` refuses to run | It checks that the extension source compiles first. Reloading broken source would leave the worker dead and unreachable, recoverable only by clicking reload in the browser. |
| A long recording contains a single frame | The page never repainted. The screencast is change-driven, so a static page yields almost nothing. The video is still the right length, and the command says so. |
| Video fails to start | `ffmpeg` is not on your PATH (`brew install ffmpeg`). Stills do not need it. |
| A file name gained a `-2` suffix | Another session claimed that name in the same second. Nothing was overwritten; this is the collision guard working. |

## Security

**Read this before you install it.** Capturing a browser you are already signed into is a
genuinely powerful capability, and it cannot be made safe by wishing.

**What the extension is granted.** `debugger` plus `<all_urls>` — the same access a DevTools
window has, over every site. This code only uses it to take pictures (`Page.captureScreenshot`,
`Page.startScreencast`, and a fixed page function for measuring an element). But the permission
itself would allow running arbitrary JavaScript in your pages, reading HttpOnly cookies, and
filling in forms. By installing this you are trusting this code, and every future version you
pull, not to do those things. Read the diff before you update.

**What someone holding your token can do.** Not only take a screenshot: list every open tab
with its title and URL — a live view of what you are browsing — and record video of any of
them, repeatedly. Treat the token like a password.

**What protects it.** The server listens on `127.0.0.1` only. Every route except `/health`
requires the token, compared in constant time. Requests carrying a foreign `Host` header are
rejected, so a web page cannot reach the server by pointing a hostname at 127.0.0.1, and the
token travels in a custom header, which a cross-origin page cannot set without a preflight
that fails. The token is read from a `600` file at both ends and never appears in a command
line. Output files and directories are created `600`/`700`.

**Where the model breaks down.** It assumes a single-user machine. On a shared box, another
local user can squat the port before the server starts, and the CLI would hand them the token.
Do not run this on a machine you share.

**It does not upload anything** — captures are written to your disk. But be clear-eyed about
what happens next: the downscaled JPEG twin exists so you can embed a capture in a report or
hand it to an assistant, and at that moment a picture of your signed-in session leaves your
machine because *you* sent it. The tool does not do it for you; it also does not stop you.

## Using it from Claude Code

`skill/SKILL.md` is a Claude Code skill: it teaches the agent when to reach for a screenshot,
which mode actually proves the point, and which traps to avoid. The installer asks whether to
copy it to `~/.claude/skills/edge-shot/SKILL.md` (`--yes` answers for you, `--no-skill`
declines), and never overwrites an existing one.

Install it deliberately. A skill is a prompt that changes how an AI agent behaves, so it is the
most sensitive file in this repository — read it before you say yes, especially in a fork.

## Documentation

- **This README** is the usage documentation.
- **[`docs/DESIGN.hu.md`](docs/DESIGN.hu.md)** is a design and measurement log, **written in
  Hungarian**. It records why each decision was made and, more usefully, the assumptions that
  turned out to be wrong when measured: that a background tab can be captured, that the
  ffmpeg concat demuxer preserves timing, that the crop factor is the device pixel ratio, and
  several others. Read it if you want to change the internals, or if you are curious how much
  of this was discovered rather than designed.
- **[`skill/SKILL.md`](skill/SKILL.md)** is the Claude Code skill: when to reach for a capture,
  which mode actually proves a point, and which traps to avoid.

## License

MIT.
