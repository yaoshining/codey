#!/usr/bin/env bash
# Install a pinned Codey checkout without changing an existing Pi installation.
set -euo pipefail

fail() { printf 'Codey: %s\n' "$*" >&2; exit 1; }

REVISION="${1:-}"
[[ "$#" -eq 1 && "$REVISION" =~ ^[0-9a-f]{40}$ ]] || fail "Usage: bash codey/install.sh <full commit SHA>"
for TOOL in git node npm tar; do
  command -v "$TOOL" >/dev/null 2>&1 || fail "$TOOL is required (Node.js 22.19 or newer)."
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' || fail "Node.js 22.19 or newer is required."

INSTALL_DIR="${CODEY_INSTALL_DIR:-$HOME/.local/share/codey}"
BIN_DIR="${CODEY_BIN_DIR:-$HOME/.local/bin}"
[[ "$INSTALL_DIR" = /* && "$BIN_DIR" = /* ]] || fail "Installation directories must be absolute paths."
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
INSTALL_DIR="$(cd -P "$INSTALL_DIR" && pwd)"
BIN_DIR="$(cd -P "$BIN_DIR" && pwd)"
CHECKOUT="$INSTALL_DIR/$REVISION"
ENTRY="$BIN_DIR/codey"

# Only replace links created for a Codey checkout in this installation directory.
if [[ -e "$ENTRY" || -L "$ENTRY" ]]; then
  [[ -L "$ENTRY" ]] || fail "Refusing to overwrite $ENTRY; choose another CODEY_BIN_DIR."
  OLD_TARGET="$(readlink "$ENTRY")"
  OLD_REVISION="${OLD_TARGET#"$INSTALL_DIR"/}"
  OLD_REVISION="${OLD_REVISION%/codey/bin/codey}"
  [[ "$OLD_REVISION" =~ ^[0-9a-f]{40}$ && "$OLD_TARGET" = "$INSTALL_DIR/$OLD_REVISION/codey/bin/codey" ]] || fail "Refusing to replace an unrelated link at $ENTRY."
fi

STAGE="$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# Isolate the smoke check from the user's project, settings, extensions and auth.
check_cli() {
  mkdir -p "$STAGE/smoke"
  (cd "$STAGE/smoke" && PI_OFFLINE=1 PI_CODING_AGENT_DIR="$STAGE/agent" "$1/codey/bin/codey" --version)
}

if [[ -e "$CHECKOUT" ]]; then
  [[ "$(git -C "$CHECKOUT" rev-parse HEAD)" = "$REVISION" ]] || fail "Existing checkout has a different revision: $CHECKOUT"
  check_cli "$CHECKOUT"
else
  git init -q "$STAGE/checkout"
  git -C "$STAGE/checkout" fetch --quiet --depth 1 https://github.com/yaoshining/codey.git "$REVISION"
  git -C "$STAGE/checkout" checkout --quiet --detach FETCH_HEAD
  [[ "$(git -C "$STAGE/checkout" rev-parse HEAD)" = "$REVISION" ]] || fail "Downloaded checkout does not match $REVISION."
  (cd "$STAGE/checkout" && npm ci --ignore-scripts --no-audit --no-fund)
  node "$STAGE/checkout/codey/hydrate-model-data.mjs"
  check_cli "$STAGE/checkout"
  mv "$STAGE/checkout" "$CHECKOUT"
fi

ln -s "$CHECKOUT/codey/bin/codey" "$STAGE/codey"
mv -f "$STAGE/codey" "$ENTRY"

# zsh is the default macOS shell. Bash login and interactive shells read different files.
# %q quotes spaces and shell metacharacters for both Bash and zsh.
PATH_LINE="$(printf 'export PATH=%q:\"$PATH\"' "$BIN_DIR")"
add_path() {
  mkdir -p "$(dirname "$1")"
  if ! [[ -f "$1" ]] || ! grep -Fqx "$PATH_LINE" "$1"; then
    printf '\n# Codey CLI path\n%s\n' "$PATH_LINE" >> "$1"
  fi
}
case "${SHELL:-}" in
  */zsh) add_path "${ZDOTDIR:-$HOME}/.zshrc" ;;
  */bash)
    add_path "$HOME/.bashrc"
    # Bash reads only the first existing login profile in this order.
    if [[ -f "$HOME/.bash_profile" ]]; then
      add_path "$HOME/.bash_profile"
    elif [[ -f "$HOME/.bash_login" ]]; then
      add_path "$HOME/.bash_login"
    elif [[ -f "$HOME/.profile" ]]; then
      add_path "$HOME/.profile"
    else
      add_path "$HOME/.bash_profile"
    fi
    ;;
  *) printf 'Add this to your shell startup file: %s\n' "$PATH_LINE" ;;
esac

printf 'Installed Codey %s at %s\n' "$REVISION" "$ENTRY"
printf 'For this terminal, run: %s\n' "$PATH_LINE"
