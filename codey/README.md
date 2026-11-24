# Codey CLI

`codey` starts this repository's Pi CLI with its own default user directory, `~/.codey/agent`. The wrapper preserves arguments, working directory, input, output, exit status and signals. It sets directory overrides and a private help-display marker for the child process. Only the root and authentication help printers have inherited source changes; package names, lockfiles and the runtime identity remain unchanged.

`codey --help` and `codey auth --help` use the Codey command name and effective directory. Internal `APP_NAME` remains `pi`: the interactive interface, other subcommand help and OAuth may still display Pi. MCP's automatic choice between client metadata documents and dynamic client registration remains Pi's original behavior. Project settings, extensions and trust checks continue to use project `.pi`.

## User directories and explicit sharing

The default Codey invocation does not inspect, copy or migrate `~/.pi/agent`. It starts with separate Codey settings, credentials, sessions and `trust.json`. An ordinary `pi` invocation from an independent shell keeps its original directory and help. No shell alias or global Pi package is replaced.

Nonempty overrides have this precedence:

| Setting | Highest to lowest priority |
| --- | --- |
| Agent directory | `CODEY_CODING_AGENT_DIR`, `PI_CODING_AGENT_DIR`, `~/.codey/agent` |
| Session directory | `--session-dir`, `CODEY_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_SESSION_DIR`, upstream configured/default session directory |

Empty environment values count as absent. Codey maps the selected values to Pi's existing environment variables only in the launched process; it does not modify the parent shell. `PI_PACKAGE_DIR`, provider credential variables, `PI_OFFLINE` and other Pi switches pass through unchanged. Codey does not set `piConfig.name` or replace the package asset root, so themes, documentation, templates and version metadata retain their upstream locations.

To explicitly share the old Pi state without copying it:

```bash
CODEY_CODING_AGENT_DIR="$HOME/.pi/agent" codey
```

This shares **writable** settings, credentials, sessions and trust records. Normal Pi startup may migrate legacy configuration or sessions **inside the directory you selected**. It is not a read-only mode. The legacy `PI_CODING_AGENT_DIR` override also remains supported. No sharing command is run automatically.

The wrapper sets `CODEY_CLI_HELP=1` solely for the two help printers. Pi runtime markers (`AI_AGENT=pi`, `PI_CODING_AGENT=true`) and shell-tool `PI_*` session metadata remain unchanged. Child processes inherit these variables, directory overrides and the help marker; a nested Pi launched inside Codey can therefore share Codey's selected state and help display. Launch stock Pi from an independent shell for its normal defaults.

## Install a reviewed commit

Requirements: macOS or Linux, Git, curl, tar, npm and Node.js **22.19 or newer**. The installer does not install Node or require sudo. It installs this checkout from GitHub, using its existing lockfile with `npm ci --ignore-scripts`. It runs from source, so no build or npm publication is required.

Pi's source runtime also needs gitignored model JSON. Codey restores only that metadata from the official `pi-ai` 1.6.0 npm archive, pinned by SHA512 in `model-data.json`, then validates it with Pi's existing validator. It does not run the archive's code, install a registry CLI, regenerate source or contact model providers. The pinned data is byte-identical to the development environment's existing provider JSON. When upstream bumps `pi-ai`, this Codey pin must be updated and verified for the new version.

Replace `FULL_COMMIT_SHA` below with the reviewed 40-character commit. Use the same value in both places:

```bash
(set -o pipefail; curl -fsSL https://raw.githubusercontent.com/yaoshining/codey/FULL_COMMIT_SHA/codey/install.sh | bash -s -- FULL_COMMIT_SHA) && export PATH="$HOME/.local/bin:$PATH"
```

The final `export` enables the command in the current terminal. The installer adds the same PATH entry to zsh's `${ZDOTDIR:-$HOME}/.zshrc`, or Bash's `.bashrc` and first active login profile. Other shells receive a PATH instruction. Existing file contents are preserved, and rerunning the same installation does not duplicate the PATH entry.

The installer places an isolated checkout at `~/.local/share/codey/<commit>` and a symlink at `~/.local/bin/codey`. Before replacing the link, it runs `codey/smoke.mjs` with a temporary HOME containing distinct fake Pi and Codey models. Read-only RPC must select Codey's new model and stock Pi's old model; a SHA256 comparison checks that default Codey did not write the old fixture. The check uses offline mode, blocks sockets and sends no prompt. It does not inherit your real directory overrides or credentials.

The installer reuses an already installed revision and refuses to overwrite an unrelated command. Installation downloads npm dependencies but does not call a model provider or change Pi globally.

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
node codey/hydrate-model-data.mjs
./codey/bin/codey --version
PI_OFFLINE=1 ./codey/bin/codey --help
node --test codey/test/*.test.mjs
npm run check
```

The wrapper uses the same source resolver as `pi-test.sh`, with a file URL so installation paths can contain spaces and URL metacharacters. Unlike the development helper, it does not consume the special `--no-env` argument. The existing `pi-test.sh` and `pi-test.ps1` are unchanged. Run `node codey/smoke.mjs` to repeat the installation's isolated RPC check.

Tests cover argument and stream forwarding, cwd, exit status, process signals, symlinks, installation failures, repeat installation and shell PATH setup. Real CLI tests use temporary HOME directories, distinct fake credentials/models/sessions, old-tree hashes and metadata, explicit overrides, project `.pi` trust, resource loading and HTML export. No prompt is sent. The MCP tests invoke real `codey mcp login` against in-memory responses for both metadata-document-only and dynamic-registration-only servers; fake browser launchers complete only local callbacks and external sockets are blocked. To test an installed copy, run `CODEY_TEST_BIN="$HOME/.local/bin/codey" node --test codey/test/runtime.test.mjs codey/test/mcp-oauth.test.mjs`.

The repository-wide check may report the inherited Mistral fixture errors for `ministral-14b-latest`. Compare with the same upstream baseline and treat additional diagnostics as regressions.

These tests run on the host platform; passing on Linux does not establish that the CLI was tested on macOS. The wrapper and installer use macOS-compatible Bash syntax and avoid GNU-only path tools.
