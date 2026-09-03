/* Shows — engine address.
   Same address as /hq/ on purpose: one Apps Script deployment answers both,
   each behind its OWN secret and its OWN spreadsheet (see board-backend/Code.gs,
   "SHOWS REALM"). Shipping it pre-wired means the page works the moment the
   engine knows the shows key.
   setup-board.command rewrites this line whenever the engine moves. Never
   hand-edit a key into this file — the key rides in the URL fragment, not in
   the repo. */
window.SHOWS_CONFIG = { apiUrl: "https://script.google.com/macros/s/AKfycbwhIzmAAHGYuWyiu5zFg7utPD1jRhJyduaWZxr0UYD5WyFaWidHiqj43He5WzsxrmahTQ/exec" };
