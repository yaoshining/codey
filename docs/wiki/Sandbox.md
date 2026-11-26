# macOS 与 Linux 沙箱

[返回手册](README.md)

| 入口 | 项目数据 | 模型与网络 |
| --- | --- | --- |
| `codey --sandbox workspace-write` | macOS Seatbelt；当前目录或 `--workspace` 指定目录可原地编辑 | 可信宿主负责模型，工具进程断网；`https_read` 可人工审批或使用域名白名单 |
| `codey sandbox --commit HEAD --image <镜像 ID>` | Linux Docker；只复制所选提交的已跟踪文件 | 容器离线，不传入用户凭据，暂无真实模型网关 |

## macOS Seatbelt

```bash
codey --sandbox workspace-write
codey --sandbox workspace-write --workspace /path/to/task
```

允许编辑工作区及私有临时目录，包括现有 worktree 和未提交文件。用户 Home、常见凭据文件和 Git 管理路径受保护。可用 `!` 或 `!!` 执行离线命令，`!!` 的输出不进入模型上下文。退出后不会保存这次沙箱会话。MCP、扩展、项目资源自动发现和附件不可用。缺少 Seatbelt 或启动检查失败时，Codey 会停止。 [macOS 详细边界](../../codey/sandbox/macos/README.md)

在带有本地 `.git` 目录的仓库根目录运行沙箱，输入 `/review` 可流式审查暂存、未暂存和未忽略的未跟踪文本改动。审查使用项目的忽略规则和 `.git/info/exclude`。收集改动的 Git worker 只能读取工作区和指定 Git 元数据，模型经宿主收取有大小限制的补丁，审查轮没有工具。结果直接显示在当前对话，Ctrl+C 可中止并继续输入。Linked worktree、带基准分支的审查、受保护文件、符号链接和非文本改动不受支持。请把其他敏感资料放在工作区外。普通模式 `/review` 仍支持原有范围。

### macOS 沙箱 RPC 与 T3

在任务目录用 `codey --sandbox workspace-write --mode rpc` 启动 JSONL 服务。客户端可查看可用模型、选择模型、发送文本、接收流式事件和取消。默认会话保存在宿主的 `~/.codey/agent/sandbox-rpc/`，按工作区隔离。用 `--no-session` 可只在内存运行。恢复只接受同一工作区内由此入口创建的会话文件。

RPC 的文件和 Bash 工具仅由 Seatbelt 内的模型工具调用，工作区在启动时确定。RPC 完全关闭工具网络，包括已有白名单的 HTTPS 读取。附件、扩展、MCP、项目资源、手动 Bash、队列消息和斜杠命令均不可用。模型请求仍经受信任宿主发出。T3 的设置方式见 [T3 Code](Workflow.md#t3-code)。

T3 在第一条消息前就会记住会话路径。Codey 此时会为持久会话保存一个私有的原生会话头，供同一工作区恢复。普通模式、其他工作区或临时探测的会话无法在沙箱 RPC 中打开。

### 在会话中管理工作树

从带本地 `.git` 目录的仓库根目录启动沙箱，运行 `/worktree`。可从当前 HEAD 新建工作树，选择复制当前对话或开始空白对话。新工作树存放在 `~/.codey/worktrees/<ID>/<项目名>`，源工作区的未提交文件不会复制。菜单也可浏览同一仓库中已由 Codey 管理的工作树，切换或复制绝对路径。剪贴板不可用时，终端会显示可手动复制的路径。

切换成功时终端会显示新目录，并重新建立该目录的沙箱。旧目录的一次性联网审批和白名单不会继承。切换失败时保留当前会话。删除只适用于非当前的干净工作树，含未跟踪或忽略文件的工作树也会保留，分支不会删除。Git 管理需要 Xcode 或 Apple Command Line Tools，并仅支持标准 SHA‑1 仓库的有限本地配置。使用 hooks、过滤器、外置对象库、链接元数据或其他非标准配置时，管理命令可能拒绝。直接从 linked worktree 启动的沙箱仍可编辑文件，请从源仓库根目录启动会话以进行管理。Linked worktree 的 `/review` 仍不可用。

如果提交包含受保护的路径（例如 `.pi` 或 `.env`），新建工作树可能在检出时被 Seatbelt 拒绝。当前会话会保留，终端会显示可能已部分创建的目录。

### HTTPS 审批与项目白名单

Agent 可通过 `https_read` 发起读取。终端会显示请求、工作目录和目的地。输入本次显示的审批码才允许读取，按 Enter 拒绝，30 秒不回答则请求过期。授权只针对这次 HTTPS GET。要维护当前工作区的精确域名列表，请在项目目录运行：

```bash
codey --sandbox workspace-write --list-domains
codey --sandbox workspace-write --allow-domain docs.example.org
codey --sandbox workspace-write --remove-domain docs.example.org
```

列表默认空，按实际工作区路径隔离，保存在宿主配置目录。授权覆盖同一个域名的合规路径，子域不继承。撤销后下次恢复询问。读取只允许公开 IPv4、HTTPS 443 及有效 TLS，限制响应大小，拒绝重定向、查询参数与文件上传。`curl`、`npm install` 等 shell 命令仍离线。`git pull` 还需要访问受保护的 Git 元数据。

- **`No models available`**：退出沙箱，在普通 Codey 用 `/login` 或修正全局网关配置，再进入沙箱。
- **Seatbelt 启动错误**：确认使用当前系统支持的 Node 和已有 `/usr/bin/sandbox-exec`。工具因隔离失败时不会回退到普通模式。
- **HTTPS 请求失败**：检查审批是否过期、站点是否提供公开 IPv4，以及目标是否需要重定向或登录。

## Linux Docker

按隔离指南从可信 Codey 提交构建本地镜像，然后使用 `docker image inspect` 取不可变镜像 ID。在任务仓库运行：

```bash
codey sandbox --commit HEAD --image "$image" --dry-run
codey sandbox --commit HEAD --image "$image"
```

`--dry-run` 只打印计划。实际运行复制所选提交，排除暂存、未暂存、未跟踪和忽略文件。容器 Home 是临时的，项目结果保留在输出所示的 `~/.codey/sandboxes/task-*/project`。检查后自行选取改动，原仓库没有自动写回。启动要求兼容的本机 Linux Docker，失败不会转为宿主运行。快照没有 Git 仓库，不能用 `/review`。 [镜像构建与隔离指南](../../codey/sandbox/README.md)
