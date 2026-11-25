# macOS Seatbelt sandbox

```bash
codey --sandbox workspace-write
codey --sandbox workspace-write --workspace "/path/to/task"
codey --sandbox workspace-write --provider openai --model <model-id>
```

The current folder or the explicitly selected workspace is editable in place, including uncommitted files. An existing linked Git worktree works as a folder. A new conversation runs in memory in a separate terminal interface. It supports text prompts, `!command`, `!!command`, `/help` and `/quit`. The model can call `read`, `write`, `edit`, `ls` and `bash`. `!!` keeps its results outside model context.

Codey makes model requests on the host with built-in provider support and plain model configuration from `~/.codey/agent`. Choose the provider and model with CLI flags or set their defaults in that directory. Executable credential values and JS provider extensions are unsupported. OAuth refresh can update the selected host credential. Content you send, including permitted tool output, can reach the selected model.

The worker uses a private temporary directory and only system shell commands on PATH. It has no tool network access and receives a fixed, small environment. Seatbelt restricts reads and writes to the workspace and private temporary directory, with readonly access to the runtime and required system paths. Git administration and common secret names such as `.env`, `.ssh`, `.aws`, `.npmrc`, private keys and Codey/Pi configuration directories are protected. Keep other secrets outside the workspace. System tools and scripts that require additional libraries, file access or network may be unavailable.

RPC/T3, extensions, MCP, automatic package or project resource discovery, attachments, `/review` and in-session worktree management are unavailable. Git commands that need shared metadata can fail. No approval command can widen the boundary. Codey stops if the Seatbelt launcher or its startup check fails.

Seatbelt uses Apple's deprecated `/usr/bin/sandbox-exec`. This is an opt-in host-kernel boundary for the tools, with no VM or container resource limits. Validate the target macOS and Node combination before relying on it. A controlled test uses only synthetic paths and a loopback mock model:

```bash
python3 codey/sandbox/macos/integration.py ./codey/bin/codey
```

The test requires `pexpect`. Ordinary Codey and the Linux Docker sandbox remain available from their existing commands.
