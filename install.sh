#!/usr/bin/env bash
# edge-shot installer: generates a token, fills in both config files, installs the
# Claude skill, then prints the one manual step that cannot be automated.
set -euo pipefail

# The root is the script's own directory, not $HOME: a clone anywhere must work.
ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${EDGE_SHOT_PORT:-8765}"
# The port is written verbatim into config.js, which the extension imports as code.
# Without this check, EDGE_SHOT_PORT could smuggle arbitrary JS into a service worker
# that holds the `debugger` permission.
if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "EDGE_SHOT_PORT must be a port number between 1 and 65535 (got: $PORT)" >&2
  exit 1
fi

if [[ -f "$ROOT/config.json" ]]; then
  # $ROOT goes through the environment, not interpolated into the JS source: a clone path
  # containing a quote would otherwise be JS injection into this very script.
  TOKEN=$(EDGE_SHOT_ROOT="$ROOT" node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.EDGE_SHOT_ROOT + '/config.json','utf8')).token)")
  # Read the port from the existing config too. Otherwise re-running with a different
  # EDGE_SHOT_PORT would point the extension at one port while the server listens on
  # another, and the only symptom would be "extension not connected".
  PORT=$(EDGE_SHOT_ROOT="$ROOT" node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.EDGE_SHOT_ROOT + '/config.json','utf8')).port || 8765)")
  echo "Reusing the existing token and port ($PORT)."
else
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  cat > "$ROOT/config.json" <<JSON
{
  "token": "$TOKEN",
  "port": $PORT,
  "jpegMaxPx": 1200,
  "jpegQuality": 55,
  "outRoot": "~/.claude/screenshots"
}
JSON
  chmod 600 "$ROOT/config.json"
  echo "Generated a new token."
fi

mkdir -p "$ROOT/extension"
cat > "$ROOT/extension/config.js" <<JS
// GENERATED FILE - written by install.sh. Do not edit by hand.
export const TOKEN = '$TOKEN';
export const PORT = $PORT;
JS

# This file carries the token too, so it must not be world-readable.
chmod 600 "$ROOT/extension/config.js"
chmod +x "$ROOT/shot" 2>/dev/null || true

command -v ffmpeg >/dev/null || echo "  NOTE: ffmpeg is not on your PATH. Stills will work, video will not."
command -v sips   >/dev/null || echo "  NOTE: sips is missing (not macOS?). The downscaled JPEG twin will be skipped."

SKILL_DIR="$HOME/.claude/skills/edge-shot"
if [[ -f "$ROOT/skill/SKILL.md" ]]; then
  if [[ -f "$SKILL_DIR/SKILL.md" ]]; then
    echo "  Claude skill already present at $SKILL_DIR (leaving it alone)."
  else
    # The skill is a prompt that changes an AI agent's behaviour, so installing it is the
    # largest trust step here. Ask when there is a terminal; skip otherwise.
    if [[ -t 0 ]]; then
      read -r -p "  Install the Claude skill to $SKILL_DIR? [y/N] " ans
    else
      ans=n
    fi
    if [[ "$ans" =~ ^[Yy]$ ]]; then
      mkdir -p "$SKILL_DIR" && cp "$ROOT/skill/SKILL.md" "$SKILL_DIR/SKILL.md"
      echo "  Claude skill installed to $SKILL_DIR"
    else
      echo "  Skipped. To install later: cp $ROOT/skill/SKILL.md $SKILL_DIR/SKILL.md"
    fi
  fi
fi

cat <<TXT

  Done. One manual step is left, once and for all:

    1. Open  edge://extensions
    2. Turn on "Developer mode" (bottom left)
    3. "Load unpacked" and choose this folder:
       $ROOT/extension

  Then verify:  $ROOT/shot health

TXT
