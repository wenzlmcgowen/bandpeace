#!/bin/bash
#
# setup-board.command — plugs the engine behind BOTH private pages into your
# Google account: the Psycho Panda board at /hq/ and the shows + logistics
# page at /shows/. Double-click me once, on the Mac mini. About a minute,
# start to finish. Safe to run again any time — re-running just updates the
# same engine.
#
# What I do, in plain English:
#   1. Take the engine code sitting next to me (Code.gs)
#   2. Put your two secret keys into a TEMPORARY copy (the files in the repo
#      never change, and no key is ever shown on screen)
#   3. Upload it to your Google account as a tiny private web service
#   4. Check it answers, wire its address into both pages, and hand you the
#      two links — one for the team, one for you.
#
# Two keys, two separate private spreadsheets: whoever has the board link
# cannot see the shows, and whoever has the shows link cannot see the board.

set -Eeuo pipefail

STEP=0

say()  { printf '%s\n' "$*"; }
gap()  { printf '\n'; }

on_err() {
  gap
  say "😬  Hmm — something went sideways around step ${STEP:-?}."
  say "    Nothing is broken and nothing secret leaked. You can simply run me again."
  say "    If it keeps happening, tell Claude: \"the board setup failed on step ${STEP:-?}\"."
}
trap on_err ERR

bail() {
  gap
  local line
  for line in "$@"; do say "$line"; done
  gap
  exit 1
}

# ---------------------------------------------------------------- where things are
# Everything is resolved from where THIS file lives, so double-clicking works
# no matter what folder Terminal happens to start in.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_FILE="$HOME/workspace/founder-os/secrets/panda-board.env"
SHOWS_SECRETS_FILE="$HOME/workspace/founder-os/secrets/shows.env"
CLASP_STATE="$HOME/.panda-board-clasp.json"   # remembers WHICH engine is ours between runs
DEPLOY_STATE="$HOME/.panda-board-deploy-id"   # remembers WHICH deployment, so re-runs update it in place

gap
say "🐼  Psycho Panda board engine setup"
say "──────────────────────────────────────────────"

# ---------------------------------------------------------------- step 7 (as a function)
# Called once we have a working engine address, from the normal path OR plan B.
finish() {
  local exec_url="$1"
  STEP=7

  gap
  say "🔌  Wiring the engine address into everything..."

  # 1) Remember the address in the private secrets file (key stays secret).
  local tmp_env
  tmp_env="$(mktemp)"
  sed "s|^PANDA_BOARD_URL=.*|PANDA_BOARD_URL=${exec_url}|" "$SECRETS_FILE" > "$tmp_env"
  grep -q '^PANDA_BOARD_URL=' "$tmp_env" || printf 'PANDA_BOARD_URL=%s\n' "$exec_url" >> "$tmp_env"
  cat "$tmp_env" > "$SECRETS_FILE"   # rewrite in place, keeping the same file
  rm -f "$tmp_env"
  chmod 600 "$SECRETS_FILE"

  # 1b) Same for the shows key file.
  if [ -f "$SHOWS_SECRETS_FILE" ]; then
    local tmp_shows
    tmp_shows="$(mktemp)"
    sed "s|^SHOWS_URL=.*|SHOWS_URL=${exec_url}|" "$SHOWS_SECRETS_FILE" > "$tmp_shows"
    grep -q '^SHOWS_URL=' "$tmp_shows" || printf 'SHOWS_URL=%s\n' "$exec_url" >> "$tmp_shows"
    cat "$tmp_shows" > "$SHOWS_SECRETS_FILE"
    rm -f "$tmp_shows"
    chmod 600 "$SHOWS_SECRETS_FILE"
  fi

  # 2) Point BOTH pages at the engine (source and deployed copy of each).
  #    If a deployed copy is somehow missing, recreate it from the source copy
  #    rather than stranding you at the finish line.
  local page
  for page in hq shows; do
    if [ ! -d "$REPO_DIR/docs/$page" ] && [ -d "$REPO_DIR/site/$page" ]; then
      mkdir -p "$REPO_DIR/docs/$page"
      cp "$REPO_DIR/site/$page/"* "$REPO_DIR/docs/$page/"
    fi
  done
  local cfg
  for cfg in "$REPO_DIR/site/hq/config.js" "$REPO_DIR/docs/hq/config.js" \
             "$REPO_DIR/site/shows/config.js" "$REPO_DIR/docs/shows/config.js"; do
    if [ ! -f "$cfg" ]; then
      bail "🤔  I couldn't find $cfg" \
           "    Both page folders should exist before I run. Tell Claude and we'll sort it."
    fi
    sed -i '' "s|apiUrl:[[:space:]]*\"[^\"]*\"|apiUrl: \"${exec_url}\"|" "$cfg"
  done

  # 3) Publish just those page files to the live site — nothing else, even if
  #    other changes happen to be sitting around in the repo.
  if [ -z "$(git -C "$REPO_DIR" status --porcelain -- site/hq docs/hq site/shows docs/shows)" ]; then
    say "    (the site already had this address — nothing new to publish)"
  else
    git -C "$REPO_DIR" add -- site/hq docs/hq site/shows docs/shows
    git -C "$REPO_DIR" commit -m "Connect the private pages to the engine" \
        -- site/hq docs/hq site/shows docs/shows >/dev/null
    if git -C "$REPO_DIR" push >/dev/null 2>&1; then
      say "    Published. The live page catches up in a minute or two."
    else
      gap
      say "⚠️   I saved everything but couldn't push to GitHub just now (maybe no internet?)."
      say "    The pages won't load on the live site until that happens."
      say "    Fix: run me again later, or tell Claude: \"push the bandpeace site\"."
    fi
  fi

  gap
  say "──────────────────────────────────────────────"
  say "🎉  Both pages are ALIVE. These are the two links that matter:"
  gap
  say "    🐼  The team board — text this one to Jess:"
  say "        https://bandpeace.com/hq/#${BOARD_TOKEN}"
  gap
  if [ -n "${SHOWS_TOKEN:-}" ]; then
    say "    🎟️   Your shows + logistics — keep this one:"
    say "        https://bandpeace.com/shows/#${SHOWS_TOKEN}"
    gap
  fi
  say "    Each link IS its own key, and they are different keys — the board"
  say "    link can't open your shows and the shows link can't open the board."
  say "    Share them like house keys, not like flyers."
  say "──────────────────────────────────────────────"
  gap
}

# ---------------------------------------------------------------- step 8 (plan B)
# If the automatic road is blocked, fall back to 90 seconds of copy-paste.
fallback_manual() {
  STEP=8
  gap
  say "🪄  Plan B — the automatic road is blocked, so we'll do one copy-paste."
  say "    Total: about 90 seconds."
  gap
  pbcopy < "$WORKDIR/Code.gs"
  say "    I just put the engine code on your clipboard."
  open "https://script.new" 2>/dev/null || say "    (open https://script.new in your browser)"
  gap
  say "    In the tab that opened:"
  say "      1. Click inside the code area, select everything (⌘A), paste (⌘V)"
  say "      2. Blue 'Deploy' button (top right) → New deployment"
  say "      3. Click the gear next to 'Select type' → choose 'Web app'"
  say "      4. Set:  Execute as → Me   ·   Who has access → Anyone"
  say "      5. Click Deploy, click through the permission screens"
  say "         (Review permissions → your account → Advanced → Allow)"
  say "      6. Copy the 'Web app' URL it shows (it ends in /exec)"
  gap
  printf '    Paste that /exec URL here and press return: '
  local pasted=""
  read -r pasted || true
  pasted="$(printf '%s' "$pasted" | tr -d '[:space:]')"
  # Strict shape check: only characters that can't confuse the wiring step.
  if ! printf '%s' "$pasted" | grep -Eq '^https://script\.google\.com/[A-Za-z0-9/_.-]+/exec$'; then
    bail "🤔  That didn't look like the /exec link (it starts with" \
         "    https://script.google.com/ and ends in /exec). Run me again and re-paste."
  fi
  # The pasted code (with your key inside) doesn't need to sit on the
  # clipboard any longer.
  printf '' | pbcopy 2>/dev/null || true
  say "    (I also cleared your clipboard — the code on it contained your key.)"
  if probe_ok "$pasted"; then
    say "    ✅  The engine answered. Beautiful."
  else
    gap
    say "    ⚠️  The engine didn't answer properly yet — sometimes Google needs a"
    say "    minute. I'll wire it up anyway; if the board page stays empty,"
    say "    double-check 'Execute as: Me' and 'Who has access: Anyone', then run me again."
  fi
  finish "$pasted"
  exit 0
}

# Ask the engine for the task list; succeed only on a real "ok":true answer.
# (Capture first, THEN grep — piping curl straight into grep -q can kill curl
# mid-write under pipefail and report a healthy engine as dead.)
probe_ok() {
  local url="$1" out=""
  out="$(curl -sL --max-time 30 "${url}?token=${BOARD_TOKEN}&action=list" 2>/dev/null || true)"
  printf '%s' "$out" | grep -q '"ok":true'
}

# Same question, asked with the OTHER key. Checked separately because the two
# halves can only be proven separately — a healthy board says nothing about
# whether the shows key made it into the uploaded code.
probe_shows_ok() {
  local url="$1" out=""
  out="$(curl -sL --max-time 30 "${url}?token=${SHOWS_TOKEN}&action=shows" 2>/dev/null || true)"
  printf '%s' "$out" | grep -q '"ok":true'
}

# clasp writes the absolute temp-folder path into .clasp.json as rootDir; that
# folder is gone by the next run, which would strand every re-run (including a
# key rotation). Pin rootDir to "." — we always run clasp from inside $WORKDIR.
normalize_clasp_state() {
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.rootDir = ".";
    fs.writeFileSync(f, JSON.stringify(j));
  ' "$1"
}

# ---------------------------------------------------------------- step 1: guards
STEP=1
if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
  bail "🙅  I need a helper called 'node' that isn't on this Mac yet." \
       "    Tell Claude: \"install node so I can run the board setup\" — then run me again."
fi
if [ ! -f "$SECRETS_FILE" ]; then
  bail "🔍  I couldn't find the secret key file:" \
       "    $SECRETS_FILE" \
       "    Tell Claude: \"the panda board secrets file is missing\"."
fi

# Read the key without ever printing it.
BOARD_TOKEN="$(sed -n 's/^PANDA_BOARD_TOKEN=//p' "$SECRETS_FILE" | head -n 1 | tr -d '[:space:]')"
if ! printf '%s' "$BOARD_TOKEN" | grep -Eq '^pp[A-Za-z0-9]{40,}$'; then
  bail "🔍  The secret key file exists but the key inside looks off." \
       "    Tell Claude: \"the panda board token looks wrong\" (don't paste the key anywhere)."
fi
say "✅  Found the board key. (It stays secret — I never show it.)"

# The shows page has its OWN key, in its own file. If that file isn't there
# yet, make one — this should stay a single double-click, not a scavenger hunt.
if [ ! -f "$SHOWS_SECRETS_FILE" ]; then
  mkdir -p "$(dirname "$SHOWS_SECRETS_FILE")"
  NEW_SHOWS_TOKEN="sh$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48)"
  {
    printf '# Shows page (bandpeace.com/shows/) — the key that IS the link.\n'
    printf '# Never commit, never paste into a chat.\n'
    printf 'SHOWS_TOKEN=%s\n' "$NEW_SHOWS_TOKEN"
    printf '# Filled in by setup-board.command once the engine is live:\n'
    printf 'SHOWS_URL=\n'
  } > "$SHOWS_SECRETS_FILE"
  chmod 600 "$SHOWS_SECRETS_FILE"
  unset NEW_SHOWS_TOKEN
  say "✅  Made a fresh key for the shows page (saved privately, never shown)."
fi

SHOWS_TOKEN="$(sed -n 's/^SHOWS_TOKEN=//p' "$SHOWS_SECRETS_FILE" | head -n 1 | tr -d '[:space:]')"
if ! printf '%s' "$SHOWS_TOKEN" | grep -Eq '^sh[A-Za-z0-9]{40,}$'; then
  bail "🔍  The shows key file exists but the key inside looks off." \
       "    Tell Claude: \"the shows token looks wrong\" (don't paste the key anywhere)."
fi
say "✅  Found the shows key too."

# ---------------------------------------------------------------- step 2: temp copy
STEP=2
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# The team roster also lives in the private secrets file (so no real names sit
# in this public repo). Format: PANDA_BOARD_TEAM=Name:emoji,Name:emoji
TEAM_ROSTER="$(sed -n 's/^PANDA_BOARD_TEAM=//p' "$SECRETS_FILE" | head -n 1)"
[ -n "$TEAM_ROSTER" ] || TEAM_ROSTER="Wenzl:🎷,Jess:✨"
TEAM_JSON="$(TEAM_ROSTER="$TEAM_ROSTER" node -e '
  const rows = process.env.TEAM_ROSTER.split(",")
    .map(s => s.trim()).filter(Boolean)
    .map(pair => {
      const i = pair.indexOf(":");
      const name = (i < 0 ? pair : pair.slice(0, i)).replace(/[&\\]/g, "").trim();
      const emoji = (i < 0 ? "" : pair.slice(i + 1)).replace(/[&\\]/g, "").trim() || "🐼";
      return [name, emoji, "yes"];
    })
    .filter(r => r[0]);
  if (!rows.length) process.exit(1);
  process.stdout.write(JSON.stringify(rows));
')"

# Inject both keys and the roster via awk+ENVIRON so none of them ever appears
# on a command line (command lines are visible to every process on the machine).
BOARD_TOKEN="$BOARD_TOKEN" SHOWS_TOKEN="$SHOWS_TOKEN" TEAM_JSON="$TEAM_JSON" awk '{
  gsub(/__PANDA_TOKEN__/, ENVIRON["BOARD_TOKEN"]);
  gsub(/__SHOWS_TOKEN__/, ENVIRON["SHOWS_TOKEN"]);
  gsub(/__PANDA_TEAM__/, ENVIRON["TEAM_JSON"]);
  print
}' "$SCRIPT_DIR/Code.gs" > "$WORKDIR/Code.gs"
cp "$SCRIPT_DIR/appsscript.json" "$WORKDIR/appsscript.json"
say "✅  Made a temporary copy of the engine with both keys inside."
say "    (The files in the repo are untouched and still hold only placeholders.)"

# ---------------------------------------------------------------- step 3: Google login
STEP=3
if [ -f "$HOME/.clasprc.json" ]; then
  say "✅  Already signed in to Google's script uploader from before."
else
  gap
  say "🔑  First, Google needs to know it's really you."
  say "    A browser tab will open — pick your Google account and click Allow."
  say "    The Terminal will sit and wait while you do. That's normal, not frozen."
  gap
  npx --yes @google/clasp login
  say "✅  Signed in."
fi

# ---------------------------------------------------------------- step 4: create/reuse + push + deploy
STEP=4
cd "$WORKDIR"
if [ -f "$CLASP_STATE" ]; then
  cp "$CLASP_STATE" "$WORKDIR/.clasp.json"
  normalize_clasp_state "$WORKDIR/.clasp.json"
  say "✅  Found the engine from a previous run — I'll update that same one."
else
  gap
  say "🏗   Creating the engine inside your Google account (10–20 seconds, quiet is normal)..."
  # (clasp v3 renamed things: no --type webapp anymore — standalone default is
  # right; the web-app nature comes from appsscript.json. Keep the error log so
  # the Apps Script API toggle wall is caught HERE too, not only at push.)
  npx --yes @google/clasp create --title "Psycho Panda Board Engine" --rootDir "$WORKDIR" >"$WORKDIR/create.log" 2>&1 || true
  if [ ! -f "$WORKDIR/.clasp.json" ]; then
    if grep -qi "Apps Script API" "$WORKDIR/create.log"; then
      STEP=5
      open "https://script.google.com/home/usersettings" 2>/dev/null || true
      gap
      say "⚙️   One Google switch needs flipping — I opened the page for you."
      say "    Turn 'Google Apps Script API' ON (top-right account must be yours),"
      say "    wait two or three minutes (Google is slow to notice), then run me again."
      gap
      exit 0
    fi
    say "    Couldn't create it automatically."
    fallback_manual
  fi
  normalize_clasp_state "$WORKDIR/.clasp.json"
  cp "$WORKDIR/.clasp.json" "$CLASP_STATE"
  rm -f "$DEPLOY_STATE"   # a brand-new engine can't reuse an old deployment id
  say "✅  Engine created."
fi

gap
say "📦  Sending the engine code up (5–20 seconds, quiet is normal)..."
PUSH_LOG="$WORKDIR/push.log"
if ! npx --yes @google/clasp push -f >"$PUSH_LOG" 2>&1; then
  # ------------------------------------------------------------ step 5: the API toggle
  STEP=5
  if grep -qi "Apps Script API" "$PUSH_LOG"; then
    open "https://script.google.com/home/usersettings" 2>/dev/null || true
    gap
    say "⚙️   One Google switch needs flipping — I opened the page for you."
    say "    On that page, turn 'Google Apps Script API' ON (it's a single toggle)."
    say "    Then just run me again. That's the whole fix."
    gap
    exit 0
  fi
  say "    The upload didn't work."
  fallback_manual
fi
say "✅  Code is up."

gap
say "🚀  Publishing it as a private web service..."
DEPLOY_ID=""
if [ -f "$DEPLOY_STATE" ]; then
  DEPLOY_ID="$(tr -d '[:space:]' < "$DEPLOY_STATE")"
fi
if [ -n "$DEPLOY_ID" ]; then
  # Update the SAME deployment in place: the address stays identical and the
  # old code — including any old key — stops being served. This is what makes
  # re-running me a real key rotation, not just a new copy next to the old one.
  if ! npx --yes @google/clasp deploy -i "$DEPLOY_ID" --description "hq" >/dev/null 2>&1; then
    say "    (couldn't update the previous deployment — making a fresh one)"
    DEPLOY_ID=""
  fi
fi
if [ -z "$DEPLOY_ID" ]; then
  DEPLOY_OUT="$(npx --yes @google/clasp deploy --description "hq" 2>&1 || true)"
  DEPLOY_ID="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'AKfycb[A-Za-z0-9_-]+' | tail -n 1 || true)"
fi
if [ -z "$DEPLOY_ID" ]; then
  say "    Publishing didn't give me an address."
  fallback_manual
fi
printf '%s\n' "$DEPLOY_ID" > "$DEPLOY_STATE"
EXEC_URL="https://script.google.com/macros/s/${DEPLOY_ID}/exec"
say "✅  Published."

# ---------------------------------------------------------------- step 6: does it answer?
STEP=6
gap
say "🩺  Checking the engine's pulse..."
if ! probe_ok "$EXEC_URL"; then
  ATTEMPT=1
  while [ "$ATTEMPT" -le 3 ]; do
    gap
    say "🔓  The engine needs a one-time 'yes' from you before it will run."
    say "    I'm opening it in your browser now."
    npx --yes @google/clasp open-script >/dev/null 2>&1 || npx --yes @google/clasp open >/dev/null 2>&1 || true
    gap
    say "    In the tab that opened, do this:"
    say "      1. Press the Run ▶ button once (top toolbar)"
    say "         (or: Deploy → Manage deployments if it nags about deployments)"
    say "      2. A permissions window appears → click 'Review permissions'"
    say "      3. Pick your Google account"
    say "      4. Click 'Advanced' → 'Go to Psycho Panda Board Engine (unsafe)' → Allow"
    say "         ('unsafe' just means Google hasn't reviewed OUR OWN private script — it's yours.)"
    gap
    printf "    Done clicking Allow? Press any key here and I'll check again... "
    read -n 1 -s -r || true
    gap
    if probe_ok "$EXEC_URL"; then
      break
    fi
    say "    Not yet (try ${ATTEMPT} of 3)."
    ATTEMPT=$((ATTEMPT + 1))
  done
  if ! probe_ok "$EXEC_URL"; then
    say "    Still no pulse after three tries — switching to plan B."
    fallback_manual
  fi
fi
say "✅  The engine answered. It even created its Google Sheet"
say "    ('Psycho Panda Board (private)' in your Drive) on that first hello."

gap
say "🩺  And the same check with the shows key..."
if probe_shows_ok "$EXEC_URL"; then
  say "✅  The shows half answered too, and made its own sheet"
  say "    ('Shows & Logistics (private)' — a separate one, on purpose)."
else
  say "⚠️   The board works but the shows half didn't answer. Nothing is broken;"
  say "    run me again in a minute. If it keeps happening, tell Claude:"
  say "    \"the shows half of the engine isn't answering\"."
fi

# ---------------------------------------------------------------- step 7: wire it all up
finish "$EXEC_URL"
