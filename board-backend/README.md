# board-backend — the engine behind both hidden pages

This folder holds the tiny "engine" behind the two private pages on this public
site: the team board at `/hq/` and the shows + logistics page at `/shows/`.
The engine is a Google Apps Script web app that lives in Wenzl's own Google
account and keeps its data in **private Google Sheets** there. Nothing about
the team's tasks or Wenzl's bookings ever touches this public repo.

**Two realms, one engine.** There is one deployment — so one thing to set up
and one Google "Allow" to click — but two completely separate halves:

| Page | Key | Its own private sheet |
| --- | --- | --- |
| `/hq/` — the team board | `pp…`, from `founder-os/secrets/panda-board.env` | Psycho Panda Board (private) |
| `/shows/` — shows + logistics | `sh…`, from `founder-os/secrets/shows.env` — **derived from the page's password**, see below | Shows & Logistics (private) |

The keys are different secrets and open different spreadsheets, so the board
link can never reach the shows and the shows link can never reach the board.
The shows half is the `SHOWS REALM` section at the bottom of `Code.gs`;
everything above it is the board and is untouched by it.

## What's in here

| File | What it is |
| --- | --- |
| `Code.gs` | The engine's code. The version committed here contains **placeholder** keys (`__PANDA_TOKEN__`, `__SHOWS_TOKEN__`) and is deliberately inert — it can never answer a real request. There is a test for that. |
| `appsscript.json` | The engine's settings: Los Angeles timezone, runs as the deploying user, reachable by the web page. |
| `setup-board.command` | The one thing a human runs. Double-click it once on the Mac mini and it does everything: signs in to Google, uploads the engine (with the real keys injected into a **temporary copy only**), publishes it, checks that *both* halves answer, and wires its address into the `/hq/` and `/shows/` pages. If the shows key file doesn't exist yet, it makes one. |
| `show-board-link.command` · `show-shows-link.command` | Double-click either to print its secret link in that Terminal window and nowhere else. |
| `README.md` | This file. |

## How the secret stays secret

- The real key lives only in a private, git-ignored file on Wenzl's machine
  (`founder-os/secrets/panda-board.env`). It is never committed, never printed
  on screen, and never written into this repo.
- `setup-board.command` copies `Code.gs` to a temporary folder, puts the real
  key into **that copy**, and uploads it. The file in this repo keeps the
  placeholder forever.
- The board link itself carries the key after the `#` — browsers never send
  that part to any server, so it can't show up in logs either.

## Where the data lives

The first time the engine gets a valid **board** request, it creates a
spreadsheet called **"Psycho Panda Board (private)"** in the owner's Google
Drive, with a `Tasks` tab and a `Team` tab. Adding a row to the `Team` tab adds
a person to the board.

The first valid **shows** request creates a second, separate spreadsheet,
**"Shows & Logistics (private)"**, with a `Shows` tab (one row per show) and an
`Items` tab (one row per logistics entry, each pinned to a show and to one of
travel / hotel / backstage).

Either sheet is the single source of truth for its half — the web page and the
CLI both just talk to the engine, and the engine talks to the sheet. Both can
be opened and hand-corrected in Google Sheets any day; every column is stored
as plain text so a date typed by hand stays the text you typed.

## The shows key and the shows password

The engine only ever sees a key, exactly like the board. What's different is
where that key comes from: `/shows/` asks for a password and stretches it into
the key in the browser (PBKDF2-SHA256, 4,000,000 rounds, public salt) — so the
password never travels and never lands here. `shows.py set-password "…"` does
the identical maths in Python and writes the result to
`founder-os/secrets/shows.env`; this setup script injects it from there.

The consequence to remember: **changing the password means re-running this
script.** Until you do, the engine still expects the key the old password made.

## Testing it without deploying

Apps Script has no local runtime, so `../tests/gas-harness.js` fakes Sheets,
Properties, Lock and Utilities well enough to run this exact file in Node:

```sh
node ../tests/engine.test.js
```

That covers the gate, both realms' validation, the id counters, and the fact
that deleting a show takes its logistics with it — before anything reaches
Google.

## Rotating a key (if a link ever leaks)

1. Put a fresh key in the file for that half. For the board, edit
   `founder-os/secrets/panda-board.env` (`PANDA_BOARD_TOKEN=pp…`, at least 40
   letters/numbers after the prefix). For the shows, don't hand-write a key —
   run `python3 .claude/scripts/shows.py set-password "…"`, which derives it
   from the new password and saves it.
2. Double-click `setup-board.command` again. It re-uploads the engine with the
   new key(s) and prints the new links.
3. Share the new link. The old one stops working the moment the new engine code
   is live — the data in the sheets is untouched. Rotating one key does not
   disturb the other half.

## Re-running setup

Totally safe. The script remembers which engine is yours (a small note at
`~/.panda-board-clasp.json`) and which published address it lives at
(`~/.panda-board-deploy-id`), and updates that same address in place — no
duplicates, and the page never needs re-wiring. That in-place update is also
what makes key rotation real: the old key stops being accepted at the same
address the moment the new code is live.
