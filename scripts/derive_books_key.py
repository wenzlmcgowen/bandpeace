#!/usr/bin/env python3
"""Turn a password into the /wenzl/ books key — the same stretching the page
does in the browser (PBKDF2-HMAC-SHA256, salt 'bandpeace-books-v1',
4,000,000 rounds, 256 bits, prefixed 'bk'). Run it once when choosing the
password, paste the printed key into secrets/books.env as BOOKS_TOKEN, and
re-run board-backend/setup-board.command so the engine learns it.

Usage: python3 scripts/derive_books_key.py        (prompts, never echoes)
"""
import getpass
import hashlib
import sys

SALT = b"bandpeace-books-v1"
ITERATIONS = 4_000_000
BITS = 256


def derive(password: str) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), SALT, ITERATIONS, BITS // 8)
    return "bk" + dk.hex()


def main() -> int:
    pw = getpass.getpass("Books password (typed blind, never stored): ")
    if not pw:
        print("No password given — nothing derived.")
        return 1
    again = getpass.getpass("Once more, to be sure: ")
    if pw != again:
        print("They don't match — run me again.")
        return 1
    print("\nThis is the key (put it in secrets/books.env as BOOKS_TOKEN=…):\n")
    print(derive(pw))
    print("\nThen re-run board-backend/setup-board.command so the engine learns it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
