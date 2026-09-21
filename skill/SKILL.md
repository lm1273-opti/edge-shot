---
name: edge-shot
description: >
  Capture lossless PNG screenshots and real-time MP4 recordings from the browser the
  user is ALREADY SIGNED INTO, straight to disk. Works with any Chromium browser
  (Edge, Chrome, Chromium, Brave) — whichever one the extension was installed into. Use whenever visual evidence
  of a web page or product UI is needed: "take a screenshot of this", "show me the
  page", "capture the bug", "before and after", "how does it look on mobile",
  "put a picture in the report". Four still modes (visible area, full page,
  CSS-selector element, mobile viewport emulation) and VIDEO recording
  (`rec-start` / `rec-stop`) for when the defect is a sequence of events rather
  than a single state. NOT for browsers other than the one the extension is
  loaded into, and not for capturing a page the agent cannot reach.
---

# edge-shot

Screenshots and recordings from the browser the user is already signed into.

**Which browser?** Whichever one the extension was loaded into at install time — Edge if
the user has it, otherwise Chrome (or Chromium/Brave). You do not choose this per call and
you do not need to: `shot health` reports the connected browser under `browsers`. Everything
below works identically in all of them.

If `health` lists **more than one** browser, every command is refused on purpose. Tab ids
are per-browser, so a capture from the wrong one would look perfectly correct. Tell the user
to remove the extension from one of the browsers.

## Commands

```bash
S=<path-to-repo>/shot          # or put it on your PATH

$S health                      # is the server up, is the extension connected
$S tabs                        # open tabs: id, title, URL
$S probe --selector "<css>" --tab <id>    # what does this selector match, and how big
$S check                       # does the extension source compile
$S reload                      # reload the extension after a code change
```

Stills. The first argument is the file name:

```bash
$S dashboard       --tab 42
$S whole-page      --tab 42 --mode fullpage
$S just-the-modal  --tab 42 --mode element --selector ".modal" --padding 8
$S on-mobile       --tab 42 --mobile 375
$S for-a-ticket    --tab 42 --url          # white bar on top carrying the page URL
```

Video, for an event sequence:

```bash
$S rec-start flow --tab 42 --quality high [--selector "<css>"] [--gif]
#   … drive the page however you like …
$S rec-stop                                # [--verify | --no-verify]
$S rec quick-clip --tab 42 --seconds 8     # fixed length, one step
$S rec-status

# several clips into one video, with a header bar per section
$S join before-after --clip a.mp4::"BEFORE · main" --clip b.mp4::"AFTER · the fix"
```

Flags: `--mode viewport|fullpage|element`, `--selector`, `--padding`, `--tab <id>`,
`--match <text>`, `--mobile [width]`, `--scale 1-4`, `--settle <ms>`, `--url`,
`--session <id>`, `--seconds 1-120`, `--quality low|normal|high`, `--gif`, `--force`,
`--verify` / `--no-verify` (verification stills on `rec-stop`), `--clip` (repeatable, `join`).

Output goes to `~/.claude/screenshots/<date>/` (configurable via `outRoot` in
`config.json`): a lossless PNG plus a width-capped JPEG twin, or an MP4.

## How to use it well

1. **Target explicitly with `--tab <id>`**, from `$S tabs`. `--match` refuses when the
   pattern hits more than one tab, because picking the first one silently photographs
   the wrong page.
2. **Run `probe` before element mode.** Selectors go stale; `probe` reports the match
   count and size. A 1x1 match is a hidden element, not what you wanted.
3. **Choose the narrowest mode that proves the point.** If the defect lives in one
   element, `--mode element` removes the cropping step and the irrelevant surroundings.
4. **Look at the image before you describe it.** A caption is a claim; only write what
   the picture actually shows. The command prints the tab title and URL for this.
5. **Prefer a still.** One image settles a state bug. Reach for video only when the
   thing you must show is movement or a sequence.

## Behaviour worth knowing (all measured)

- **The captured tab comes to the front**, then the previous one is restored. A headed
  browser does not render a background tab, so there is nothing to capture until it is
  visible. The flash on screen is expected.
- **Output is at device pixel ratio 2** (3 on mobile), so small UI text stays readable.
- **The debugger notification bar does not appear in the image**; the capture is of the
  rendered page, not the browser chrome. That is also why no address bar is included:
  use `--url` when the picture must identify the page by itself.
- **Full-page mode can equal viewport mode** in apps that scroll inside an inner
  container. That is correct; target the scrolling container with element mode.
- **A recording freezes if its tab loses focus.** While a recording runs, capturing a
  *different* tab is refused, and the error says which tab is being recorded.
- **A static page yields almost no frames**, because the screencast is change-driven.
  The recording still has the right length but is effectively a still, and the command
  says so loudly.
- **Video crop is measured at the start.** If the element moves or resizes during the
  recording, the crop does not follow.
- **A recording's duration proves nothing; look at its frames.** A recording that froze
  part way through still has the full duration, a believable frame count and a believable
  frame rate. Measured on 2026-09-21: two 70-second recordings froze mid-scene and nothing
  in the output revealed it; only a frame pulled out with ffmpeg did. So `rec-stop` now
  reports any frame gap longer than three seconds (at the end or in the middle), a
  per-navigation table of frame counts with the URL of each stretch, and a detached
  debugger. A stretch with zero frames gets its own warning. Falsified both ways: a
  deliberately stopped page reported a 24.06 second gap, healthy recordings stayed silent.
- **Verification stills are written for you.** When a recording contains a navigation,
  `rec-stop` extracts the start frame, one frame after each navigation and the final frame
  into `<video>-kockak/`. **Read them before you write a caption** — the caption is a claim,
  and the duration is not evidence for it.
- **Record a multi-step scene as several clips, then `join` them.** This turned out more
  reliable than one long recording: a short clip shows its own failure at once, and a
  spoiled stretch can be re-recorded alone. `join` labels each section (a `BEFORE` label
  gets a red strip, `AFTER` green) and writes a still from the end of each one.
- **What the tool does NOT claim.** The extension re-arms the screencast after a main-frame
  navigation and retries the attach up to three times after a detach, but the freeze that
  motivated this could not be reproduced in isolation: a plain same-origin navigation was
  followed correctly even by the older code (818 frames, 25.9 fps, ending on the right
  page). Treat the measurement as the safeguard, not the fix.

## Several agent sessions, one browser

Jobs are serialised, so concurrent captures on different tabs do not fight over focus.
File names never overwrite: a collision gets a `-2` suffix and the command says so.
Pass `--session <id>` (or set `EDGE_SHOT_SESSION`) when more than one session is
active — without it every caller is `anon` and the recording ownership check cannot
protect anything.

## Troubleshooting

| Symptom | Cause and remedy |
|---|---|
| `extension not connected` | The browser is not running, or the service worker stopped. Click the extension icon once. After a server restart, reconnection can take up to a minute. |
| `TWO BROWSERS are connected` | The extension is loaded into more than one browser. Tab ids clash, so nothing runs until one copy is removed. |
| `selector matched nothing` | Run `probe`. The element may be inside an iframe (the query runs on the main document) or not rendered yet — try `--settle 1500`. |
| `Cannot access chrome:// and edge:// URLs` | The browser forbids extensions from reading its own internal pages. Not fixable. |
| `N tabs match the pattern` | Use one of the `--tab <id>` values printed. |
| `a recording is running on tab …` | Another session is recording. Wait, or `rec-stop --force` if it is yours. |
| `RELOAD REFUSED` | The extension source does not compile. Reloading broken source would leave the worker dead and unreachable. Fix the reported error first. |

## What this does not do

- It does not navigate or click. Drive the page with whatever browser-automation tool
  you have; this tool only captures.
- It cannot capture the browser's own internal pages.
- Element mode does not look inside iframes.
