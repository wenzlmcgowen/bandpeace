# board-backend — the Psycho Panda board engine

This folder holds the tiny "engine" behind the hidden team board at `/hq/`.
The engine is a Google Apps Script web app that lives in Wenzl's own Google
account and keeps all the board data in a **private Google Sheet** there.
Nothing about the team's tasks ever touches this public repo.

## What's in here

| File | What it is |
| --- | --- |
| `Code.gs` | The engine's code. The version committed here contains a **placeholder** key (`__PANDA_TOKEN__`) and is deliberately inert — it can never answer a real request. |
| `appsscript.json` | The engine's settings: Los Angeles timezone, runs as the deploying user, reachable by the web page. |
| `setup-board.command` | The one thing a human runs. Double-click it once on the Mac mini and it does everything: signs in to Google, uploads the engine (with the real key injected into a **temporary copy only**), publishes it, checks it answers, and wires its address into the `/hq/` page. |
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

The first time the engine gets a valid request, it creates a spreadsheet
called **"Psycho Panda Board (private)"** in the owner's Google Drive, with a
`Tasks` tab and a `Team` tab. That sheet is the single source of truth — the
web page and the CLI both just talk to the engine, and the engine talks to the
sheet. Adding a row to the `Team` tab adds a person to the board.

## Rotating the key (if the link ever leaks)

1. Put a fresh key in `founder-os/secrets/panda-board.env`
   (`PANDA_BOARD_TOKEN=pp…` — at least 40 letters/numbers after `pp`).
2. Double-click `setup-board.command` again. It re-uploads the engine with the
   new key and prints the new link.
3. Text the new link to the team. The old link stops working the moment the
   new engine code is live — the data in the sheet is untouched.

## Re-running setup

Totally safe. The script remembers which engine is yours (a small note at
`~/.panda-board-clasp.json`) and which published address it lives at
(`~/.panda-board-deploy-id`), and updates that same address in place — no
duplicates, and the page never needs re-wiring. That in-place update is also
what makes key rotation real: the old key stops being accepted at the same
address the moment the new code is live.
