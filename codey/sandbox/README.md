# Offline Codey sandbox

`codey sandbox` runs the entire Codey process and its tools inside one Linux Docker container. It starts an interactive, offline session with a disposable home. The shell and tools can edit a task snapshot locally. A model gateway and permission escalation flow are separate future work. Provider credentials stay outside the sandbox.

## Build a local image

Use a trusted Codey checkout and an existing local Linux Docker Engine with default seccomp and CPU, memory, swap and PID limits. The launcher connects to `/var/run/docker.sock` as your non-root user, bypassing Docker contexts and user configuration. The engine must be able to mount files owned by that UID and GID.

From the reviewed **Codey source checkout**, build the image from its committed files. The image build contacts the container registry, Debian and npm. Build once, then run the resulting image offline by its immutable local ID.

```bash
(set -o pipefail; git archive HEAD | docker build -f codey/sandbox/Dockerfile -t codey-sandbox:local -)
image="$(docker image inspect --format '{{.Id}}' codey-sandbox:local)"
```

## Choose the task input

In the task's Git worktree, identify the commit to include. The image ID below comes from the trusted build above.

```bash
git status --short
codey sandbox --commit HEAD --image "$image" --dry-run
codey sandbox --commit HEAD --image "$image"
```

The explicit commit selects the entire tracked tree of that commit. Staged, unstaged, untracked and ignored files are excluded, even if there are local edits. Commit the changes you want to include first. Use a commit whose contents are safe to expose to the task process, including any tracked configuration. Codey does not scan committed files for secrets. Dry-run resolves the tree and prints the planned container arguments, without creating a snapshot or calling Docker. A real run validates Docker before copying the commit's blobs.

The snapshot contains Git blob bytes and executable bits, independent of checkout filters or tracked export attributes. It accepts direct relative symlinks to files or directories within the snapshot. Submodules, links to missing or external targets, and link chains are refused. Git LFS objects remain pointer files. Input is limited to 10,000 files and 128 MiB.

The output path is printed before Codey starts and lives under `~/.codey/sandboxes/task-*/project`. The source checkout, index and shared Git metadata stay in place. This version provides a file snapshot without a Git repository, so Git-based features such as `/review` do not run there. Inspect the output as task-produced files and select the changes to copy back yourself. Codey keeps task files after success or failure and has no automatic cleanup or writeback. Container Home and session state are disposable.

## Isolation and verification

The task starts with no network interface beyond loopback, an unprivileged numeric UID/GID, all capabilities dropped, default seccomp, and no new privileges. It has a read-only root, a 256 MiB private tmpfs at `/tmp`, 32 MiB shared memory, one CPU, 1 GiB memory with no additional swap, and at most 128 PIDs. Its only host bind is the new task snapshot, with recursive mounts disabled. The source checkout, Git metadata, host Home, Docker socket and host environment are excluded. Project settings and extensions start disabled. Docker failures stop the launch. The retained task directory needs host disk space and has no quota.

Run the entry-point tests without Docker. On a compatible Linux Docker host, use the optional integration check with Python 3, `pexpect` and cgroup v2. It uses only synthetic repositories and an in-process fake model, and checks the allowed project edit, host canaries, runtime limits and a denied network connection to a documentation address.

```bash
node --test codey/test/sandbox.test.mjs
python3 codey/sandbox/integration.py ./codey/bin/codey "$image"
```

[Docker run reference](https://docs.docker.com/reference/cli/docker/container/run/) · [Docker none network](https://docs.docker.com/engine/network/drivers/none/)
