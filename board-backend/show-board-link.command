#!/bin/bash
# Prints the Psycho Panda board link (the secret one) — in THIS window only.
S="$HOME/workspace/founder-os/secrets/panda-board.env"
T="$(sed -n 's/^PANDA_BOARD_TOKEN=//p' "$S" | head -1 | tr -d '[:space:]')"
if [ -z "$T" ]; then echo "No key found — tell Claude."; exit 1; fi
echo
echo "🐼  Your board link (the link IS the key — share like a house key):"
echo
echo "        https://bandpeace.com/hq/#${T}"
echo
