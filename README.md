# edge-shot

Lossless screenshots and real-time screen recordings from your **logged-in Microsoft Edge**,
straight to disk, driven from the command line or from an AI coding agent.

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

- macOS (the JPEG twin uses `sips`; everything else is cross-platform)
- Microsoft Edge, or any Chromium browser that loads MV3 extensions
- Node.js 18 or newer
- `ffmpeg` on your PATH, only if you want video

## Install

```bash
git clone https://github.com/lm1273-opti/edge-shot.git
cd edge-shot
./install.sh
```

The installer generates a private token, writes the two config files, and prints the one manual
step that cannot be automated:

1. open `edge://extensions`
2. turn on **Developer mode**
3. **Load unpacked** and pick the `extension/` folder of this repo

Then check it:

```bash
./shot health
```

The local server starts itself on demand; there is nothing to run in the background.

## How it works

```
CLI ──POST──▶ server (127.0.0.1) ◀──long-poll── Edge extension
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
- **Full-page mode can equal viewport mode** in apps that scroll inside an inner container. That
  is correct behaviour; use element mode on the scrolling container instead.
- **The browser's own pages** (`edge://…`) cannot be captured. That is a browser rule.

## Portability

Written and measured on macOS with Edge 153 and Node 26. Elsewhere:

- **Linux / Windows**: everything works except the downscaled JPEG twin, which uses the
  macOS `sips` tool. The installer warns, and the capture command reports it rather than
  producing a silently missing file.
- **Chrome instead of Edge**: the extension uses the standard `chrome.*` APIs and loads
  the same way; only the `edge://extensions` address differs.
- **Port in use**: `EDGE_SHOT_PORT=9000 ./install.sh` writes the port into both config
  files. Re-running the installer keeps whatever port is already configured.
- **Tab ids change** when the browser restarts, so never store a `--tab` value; run
  `shot tabs` again.

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
copy it to `~/.claude/skills/edge-shot/SKILL.md`, and never overwrites an existing one.

Install it deliberately. A skill is a prompt that changes how an AI agent behaves, so it is the
most sensitive file in this repository — read it before you say yes, especially in a fork.

## License

MIT.
