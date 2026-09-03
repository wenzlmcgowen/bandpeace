#!/bin/bash
# Prints the shows + logistics link (the secret one) — in THIS window only.
S="$HOME/workspace/founder-os/secrets/shows.env"
T="$(sed -n 's/^SHOWS_TOKEN=//p' "$S" | head -1 | tr -d '[:space:]')"
if [ -z "$T" ]; then echo "No key found — tell Claude."; exit 1; fi
echo
echo "🎟️   Your shows link (the link IS the key — share like a house key):"
echo
echo "        https://bandpeace.com/shows/#${T}"
echo
