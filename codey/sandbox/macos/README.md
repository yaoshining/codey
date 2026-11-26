# macOS Seatbelt sandbox

```bash
codey --sandbox workspace-write
codey --sandbox workspace-write --workspace "/path/to/task"
codey --sandbox workspace-write --provider openai --model <model-id>
```

The current folder or the explicitly selected workspace is editable in place, including uncommitted files. An existing linked Git worktree works as a folder. A new conversation runs in memory in a separate terminal interface. It supports text prompts, `!command`, `!!command`, `/help` and `/quit`. The model can call `read`, `write`, `edit`, `ls` and `bash`. `!!` keeps its results outside model context.

Codey makes model requests on the host with built-in provider support and plain model configuration from `~/.codey/agent`. Choose the provider and model with CLI flags or set their defaults in that directory. Executable credential values and JS provider extensions are unsupported. OAuth refresh can update the selected host credential. Content you send, including permitted tool output, can reach the selected model.

On startup Codey selects models from the installed catalog and a copy of the existing local model cache, using the host's configured credentials. A custom `models.json` is optional. Startup does not fetch model catalogs. To sign in, exit the sandbox, run regular `codey` and use `/login` there, then reopen the sandbox.

The worker uses a private temporary directory and only system shell commands on PATH. It has no tool network access and receives a fixed, small environment. Seatbelt restricts reads and writes to the workspace and private temporary directory, with readonly access to the runtime and required system paths. Git administration and common secret names such as `.env`, `.ssh`, `.aws`, `.npmrc`, private keys and Codey/Pi configuration directories are protected. Keep other secrets outside the workspace. System tools and scripts that require additional libraries, file access or network may be unavailable.

When a task needs to read a public HTTPS URL, the model can call `https_read`. The terminal shows the operation, working directory and destination. Type the displayed approval code to allow just that read, or press Enter to deny it. Unanswered requests expire after 30 seconds. The host performs one HTTPS GET for the displayed URL using a public IPv4 address and TLS certificate validation. It accepts bounded text responses and cannot upload files, send credentials, or follow redirects. Shell commands stay offline, including `curl` and `npm install`. `git pull` also needs access to protected Git metadata.

The user can authorize exact hostnames for `https_read` in a selected workspace:

```bash
codey --sandbox workspace-write --workspace /path/to/project --list-domains
codey --sandbox workspace-write --workspace /path/to/project --allow-domain docs.example.org
codey --sandbox workspace-write --workspace /path/to/project --remove-domain docs.example.org
```

Omit `--workspace` to use the current directory. The list starts empty and is stored under `~/.codey/agent/sandbox-network-domains` on the host. A grant uses the canonical workspace directory, so a symlink alias shares that list and another worktree has its own. Exact grants cover every permitted URL path on that hostname. Subdomains and wildcards are excluded. HTTPS, port 443, public IPv4, TLS verification, response limits, and the restrictions on queries and redirects still apply. Removing a grant restores the prompt on the next read.

`/review` streams a read-only review of staged, unstaged, and nonignored untracked text from the root of a local Git checkout. It uses Apple Git (Xcode or Command Line Tools), collects the patch in a separate offline Seatbelt worker and gives the selected host model one bounded request with no tools. Press Ctrl+C to cancel. The review does not write a report, change the checkout or index, or feed its patch into later conversation turns. It refuses protected paths, symlinks, hard-linked working files and non-text changes. The patch limit is 64 KiB. Keep other secrets outside the workspace.

The review worker reads the local index, HEAD, branch refs, object database and repository excludes. It uses a separate scratch Git configuration without repository filters, hooks, external diff or host Git configuration. Workspace and Git metadata writes are denied. Review requires a standard SHA-1 checkout with a local `.git` directory. Linked worktree review and base-branch review are unavailable. RPC/T3, extensions, MCP, automatic package or project resource discovery and attachments are unavailable. Codey stops if the Seatbelt launcher or its startup check fails.

Start from the source repository root and use `/worktree` to create a managed checkout from the current HEAD. You can copy the current in-memory conversation or start an empty one. The new checkout does not copy uncommitted files. Browse can switch to another managed checkout, copy its canonical path, or delete it if it is inactive and clean, including ignored and untracked files. Git branches are kept. A failed switch leaves the previous sandbox and conversation active.

The user-only manager runs fixed Apple Git commands under a separate offline policy and checks the source, checkout registration, and private Codey receipt before switching or deleting. It ignores host Git configuration and rejects unsupported local configuration and alternate object databases. Every switched workspace gets a new worker policy and its own existing domain grants. Model tools still cannot access shared Git metadata. A session launched directly inside a linked checkout can edit files. Start at the source repository root to use the manager.

If HEAD tracks protected paths such as `.pi` or `.env`, Seatbelt can refuse checkout creation. The existing conversation stays active and the terminal reports where a partial checkout may remain.

Seatbelt uses Apple's deprecated `/usr/bin/sandbox-exec`. This is an opt-in host-kernel boundary for the tools, with no VM or container resource limits. Validate the target macOS and Node combination before relying on it. A controlled test uses only synthetic paths and a loopback mock model:

```bash
python3 codey/sandbox/macos/integration.py ./codey/bin/codey
```

The test requires `pexpect`. Ordinary Codey and the Linux Docker sandbox remain available from their existing commands.
