#!/usr/bin/env bash
# edge-shot installer: generates a token, fills in both config files, optionally installs
# the Claude skill, then prints the one manual step that cannot be automated.
# Safe to re-run: an existing config.json keeps its token and port.
set -euo pipefail

# The root is the script's own directory, not $HOME: a clone anywhere must work.
ROOT="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$HOME/.claude/skills/edge-shot"

# Exit codes (also listed in --help and README):
#   0 installed or already installed
#   2 usage error (unknown flag)
#   3 node missing or older than 18
#   4 invalid port (EDGE_SHOT_PORT or the port stored in config.json)
#   5 existing config.json is unreadable or has no token
#   6 configs written, but no Chromium browser was found (set EDGE_SHOT_BROWSER)

usage() {
  cat <<TXT
Usage: ./install.sh [-y|--yes] [--no-skill] [--json] [-h|--help]

Generates a private token, writes config.json and extension/config.js (both 600),
optionally installs the Claude skill, and prints how to load the extension.
Re-running keeps the existing token and port.

Flags
  -y, --yes     Answer yes to every question (installs the Claude skill). Required for
                the skill in a non-interactive run; without it the skill is skipped.
  --no-skill    Never install the Claude skill (wins over --yes).
  --json        Print a machine-readable summary on stdout instead of prose; notes and
                errors go to stderr. Implies non-interactive (no question is asked).
  -h, --help    This text.

Environment
  EDGE_SHOT_PORT=8765         Server port, 1-65535. Ignored when config.json already exists
                              (its stored port is kept so the two config files never diverge).
  EDGE_SHOT_BROWSER=<name>    Edge | Chrome | Chromium | Brave. Overrides detection and
                              picks the extensions-page address in the instructions.
  EDGE_SHOT_ASSUME_YES=1      Same as --yes.

Exit codes
  0  installed, or already installed (see "status" in --json)
  2  usage error
  3  node missing or older than 18
  4  invalid port
  5  existing config.json unreadable or without a token
  6  configs written, but no Chromium browser found (EDGE_SHOT_BROWSER fixes it)
TXT
}

YES="${EDGE_SHOT_ASSUME_YES:-0}"; NO_SKILL=0; JSON=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   YES=1 ;;
    --no-skill) NO_SKILL=1 ;;
    --json)     JSON=1 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Prose goes to stdout normally, to stderr in --json mode so stdout stays pure JSON.
say()  { if (( JSON )); then echo "$*" >&2; else echo "$*"; fi; }
fail() { echo "install.sh: $2" >&2; exit "$1"; }

# --- Prerequisites, before touching anything ------------------------------------------
command -v node >/dev/null || fail 3 "node is not on your PATH. Install Node.js 18 or newer (https://nodejs.org) and re-run."
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' \
  || fail 3 "node $(node --version) is too old; edge-shot needs Node.js 18 or newer."

# The port is written verbatim into config.js, which the extension imports as code.
# Without this check a port value could smuggle arbitrary JS into a service worker that
# holds the `debugger` permission. Applied to EDGE_SHOT_PORT and to the stored port alike.
check_port() {
  if ! [[ "$1" =~ ^[0-9]{1,5}$ ]] || (( $1 < 1 || $1 > 65535 )); then
    fail 4 "port must be a number between 1 and 65535 (got: '$1')"
  fi
}
PORT="${EDGE_SHOT_PORT:-8765}"; check_port "$PORT"

# --- config.json: reuse token AND port, or generate -----------------------------------
if [[ -f "$ROOT/config.json" ]]; then
  # $ROOT goes through the environment, not interpolated into the JS source: a clone path
  # containing a quote would otherwise be JS injection into this very script.
  { read -r TOKEN; read -r PORT; } < <(EDGE_SHOT_ROOT="$ROOT" node -e '
    const c = JSON.parse(require("fs").readFileSync(process.env.EDGE_SHOT_ROOT + "/config.json", "utf8"));
    console.log(c.token || ""); console.log(c.port || 8765);' 2>/dev/null) \
    || fail 5 "$ROOT/config.json exists but is not valid JSON. Fix or delete it and re-run."
  [[ -n "$TOKEN" ]] || fail 5 "$ROOT/config.json has no token. Delete it and re-run to generate a new one."
  check_port "$PORT"
  STATUS=already-installed
  say "Existing config.json found: reusing its token and port ($PORT)."
else
  TOKEN=$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')
  cat > "$ROOT/config.json" <<JSON
{
  "token": "$TOKEN",
  "port": $PORT,
  "jpegMaxPx": 1200,
  "jpegQuality": 55,
  "outRoot": "~/.claude/screenshots"
}
JSON
  STATUS=installed
  say "Generated a new token (port $PORT)."
fi
chmod 600 "$ROOT/config.json"

# extension/config.js carries the token too, so it must not be world-readable.
cat > "$ROOT/extension/config.js" <<JS
// GENERATED FILE - written by install.sh. Do not edit by hand.
export const TOKEN = '$TOKEN';
export const PORT = $PORT;
JS
chmod 600 "$ROOT/extension/config.js"
chmod +x "$ROOT/shot" 2>/dev/null || true

# --- Which Chromium browser hosts the extension? --------------------------------------
# The code is identical for all of them; only the extensions-page address and the corner
# holding the Developer-mode toggle differ, and that toggle is the step people miss.
detect_browser() {
  [[ -n "${EDGE_SHOT_BROWSER:-}" ]] && { echo "$EDGE_SHOT_BROWSER"; return; }
  if [[ "$(uname -s)" == Darwin ]]; then
    for pair in "Microsoft Edge:Edge" "Google Chrome:Chrome" "Chromium:Chromium" "Brave Browser:Brave"; do
      [[ -d "/Applications/${pair%%:*}.app" ]] && { echo "${pair##*:}"; return; }
    done
  else
    for pair in microsoft-edge:Edge google-chrome:Chrome chromium:Chromium brave-browser:Brave; do
      command -v "${pair%%:*}" >/dev/null && { echo "${pair##*:}"; return; }
    done
  fi
  echo none
}
BROWSER="$(detect_browser)"
case "$BROWSER" in
  Edge)     EXT_URL="edge://extensions";     DEV_WHERE="bottom-left of the sidebar" ;;
  Chrome)   EXT_URL="chrome://extensions";   DEV_WHERE="top-right of the page" ;;
  Chromium) EXT_URL="chromium://extensions"; DEV_WHERE="top-right of the page" ;;
  Brave)    EXT_URL="brave://extensions";    DEV_WHERE="top-right of the page" ;;
  *)        EXT_URL="chrome://extensions";   DEV_WHERE="top-right of the page" ;;
esac

command -v ffmpeg >/dev/null || say "NOTE: ffmpeg is not on your PATH. Stills will work, video will not."
command -v sips   >/dev/null || say "NOTE: sips is missing (not macOS?). The downscaled JPEG twin will be skipped."

# --- Claude skill: never a silent default ----------------------------------------------
# The skill is a prompt that changes an AI agent's behaviour, so installing it is the
# largest trust step here. Interactive: ask. Non-interactive: only on an explicit yes.
SKILL=skipped
if (( NO_SKILL )); then
  SKILL=declined
elif [[ -f "$SKILL_DIR/SKILL.md" ]]; then
  SKILL=already-present
  say "Claude skill already present at $SKILL_DIR (leaving it alone)."
else
  ans=n
  if (( YES )); then ans=y
  elif [[ -t 0 ]] && (( ! JSON )); then read -r -p "Install the Claude skill to $SKILL_DIR? [y/N] " ans
  fi
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    mkdir -p "$SKILL_DIR" && cp "$ROOT/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
    SKILL=installed
    say "Claude skill installed to $SKILL_DIR"
  else
    say "Claude skill not installed. Pass --yes to install it, or later: cp $ROOT/skill/SKILL.md $SKILL_DIR/SKILL.md"
  fi
fi

# --- Report ----------------------------------------------------------------------------
EXIT=0
if [[ "$BROWSER" == none ]]; then
  EXIT=6
  say "NOTE: no Chromium-based browser found. Configs are written; install Edge, Chrome, Chromium or Brave,"
  say "      or set EDGE_SHOT_BROWSER=Chrome and re-run to get the matching instructions."
fi

if (( JSON )); then
  # Built by node so paths with quotes or backslashes are escaped correctly; values travel
  # through the environment for the same reason as $ROOT above.
  S_STATUS="$STATUS" S_ROOT="$ROOT" S_PORT="$PORT" S_BROWSER="$BROWSER" S_EXT_URL="$EXT_URL" \
  S_DEV_WHERE="$DEV_WHERE" S_SKILL="$SKILL" S_SKILL_DIR="$SKILL_DIR" S_EXIT="$EXIT" \
  S_FFMPEG="$(command -v ffmpeg || true)" S_SIPS="$(command -v sips || true)" node -e '
    const e = process.env;
    console.log(JSON.stringify({
      status: e.S_STATUS, exitCode: +e.S_EXIT, root: e.S_ROOT, port: +e.S_PORT,
      browser: e.S_BROWSER === "none" ? null : e.S_BROWSER,
      configJson: e.S_ROOT + "/config.json", extensionConfig: e.S_ROOT + "/extension/config.js",
      extensionDir: e.S_ROOT + "/extension", cli: e.S_ROOT + "/shot",
      skill: e.S_SKILL, skillPath: e.S_SKILL_DIR + "/SKILL.md",
      ffmpeg: !!e.S_FFMPEG, sips: !!e.S_SIPS,
      manualStep: { extensionsPage: e.S_EXT_URL, developerModeToggle: e.S_DEV_WHERE,
                    loadUnpackedFolder: e.S_ROOT + "/extension", verify: e.S_ROOT + "/shot health" }
    }, null, 2));'
  exit "$EXIT"
fi

cat <<TXT

  Done ($STATUS). One manual step is left, once and for all:

    1. Open  $EXT_URL   (in $BROWSER)
       Type it in the address bar; it will not come up in a search.

    2. Turn on the "Developer mode" toggle, $DEV_WHERE.
       Without it, the button in step 3 does not appear at all.

    3. Click "Load unpacked" and choose this FOLDER (not a file inside it):
       $ROOT/extension

       A card named "edge-shot" should appear in the list. A warning about
       developer-mode extensions is normal for any unpacked extension.

  Then verify:  $ROOT/shot health

  Load it into ONE browser only. Tab ids differ per browser, so a second copy would
  make "--tab 42" ambiguous; the server detects that and refuses rather than guessing.

TXT
exit "$EXIT"
