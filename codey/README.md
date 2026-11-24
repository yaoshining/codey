# Codey CLI

`codey` starts this repository's Pi CLI. The wrapper passes every argument, the working directory, environment, input, output, exit status and signals through to the same upstream source entry. It does not change Pi source, package names or lockfiles, and does not replace any `pi` command.

Pi's `.pi` configuration, credentials, extensions, sessions, help text and interactive interface retain their existing behavior and names. Both commands therefore share Pi settings. Codey adds only an executable name; rebranding the interface is outside this change.

## Install a reviewed commit

Requirements: macOS or Linux, Git, npm and Node.js **22.19 or newer**. The installer does not install Node or require sudo. It installs this checkout from GitHub, using its existing lockfile with `npm ci --ignore-scripts`. It runs from source, so no build or npm publication is required.

Replace `FULL_COMMIT_SHA` below with the reviewed 40-character commit. Use the same value in both places:

```bash
(set -o pipefail; curl -fsSL https://raw.githubusercontent.com/yaoshining/codey/FULL_COMMIT_SHA/codey/install.sh | bash -s -- FULL_COMMIT_SHA) && export PATH="$HOME/.local/bin:$PATH"
```

The final `export` enables the command in the current terminal. The installer adds the same PATH entry to zsh's `${ZDOTDIR:-$HOME}/.zshrc`, or Bash's `.bashrc` and first active login profile. Other shells receive a PATH instruction. Existing file contents are preserved, and rerunning the same installation does not duplicate the PATH entry.

The installer places an isolated checkout at `~/.local/share/codey/<commit>` and a symlink at `~/.local/bin/codey`. It checks the CLI before replacing the link, reuses an already installed revision, and refuses to overwrite an unrelated command. Installation downloads npm dependencies but does not call a model provider. It does not install or change Pi globally.

To customize locations, pass absolute `CODEY_INSTALL_DIR` and `CODEY_BIN_DIR` variables to the **bash process** in the pipeline. The current-terminal PATH export must then use that bin directory as well. Example from a checkout whose commit is already pushed:

```bash
CODEY_INSTALL_DIR="$HOME/Applications/Codey" CODEY_BIN_DIR="$HOME/bin" bash codey/install.sh "$(git rev-parse HEAD)"
export PATH="$HOME/bin:$PATH"
```

Start in the project you want to work on:

```bash
cd /path/to/project
codey
```

All Pi options remain available, for example `codey --help`, `codey --version` and `codey --mode rpc --no-session`. Updating Codey means rerunning the installer with a new reviewed commit. Pi's inherited `update` command is not a Codey checkout updater. Prior checkouts remain available for rollback by rerunning the installer with their commit.

To uninstall, remove the `~/.local/bin/codey` symlink and the Codey checkout directory, then remove the `# Codey CLI path` line and following export from the shell startup files. Pi's settings and any separately installed `pi` are unaffected.

## Run and verify from a checkout

```bash
npm ci --ignore-scripts
./codey/bin/codey --version
PI_OFFLINE=1 ./codey/bin/codey --help
node --test codey/test/*.test.mjs
npm run check
```

The wrapper uses the same source resolver as `pi-test.sh`, with a file URL so installation paths can contain spaces and URL metacharacters. Unlike the development helper, it does not consume the special `--no-env` argument. The existing `pi-test.sh` and `pi-test.ps1` are unchanged.

Tests cover argument and stream forwarding, cwd, environment, exit status, process signals, symlinks, installation failures, repeat installation and shell PATH setup with temporary home directories. The runtime tests invoke `codey` from PATH and exercise the real CLI's version, help and read-only RPC (`get_state` and `get_messages`). They isolate configuration, enable offline mode and block socket connections; no prompt is sent. To test an installed copy, run `CODEY_TEST_BIN="$HOME/.local/bin/codey" node --test codey/test/runtime.test.mjs`.

These tests run on the host platform; passing on Linux does not establish that the CLI was tested on macOS. The wrapper and installer use macOS-compatible Bash syntax and avoid GNU-only path tools.
