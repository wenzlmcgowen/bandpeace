/* WENZL books — engine address.
   Same address as /hq/ and /shows/ on purpose: one Apps Script deployment
   answers all three, each behind its OWN secret and its OWN spreadsheet
   (see board-backend/Code.gs, "BOOKS REALM").
   setup-board.command rewrites this line whenever the engine moves. Never
   hand-edit a key into this file — keys never live in the repo. */
window.BOOKS_CONFIG = { apiUrl: "https://script.google.com/macros/s/AKfycbwhIzmAAHGYuWyiu5zFg7utPD1jRhJyduaWZxr0UYD5WyFaWidHiqj43He5WzsxrmahTQ/exec" };
