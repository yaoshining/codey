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

允许编辑工作区及私有临时目录，包括现有 worktree 和未提交文件。用户 Home、常见凭据文件和 Git 管理路径受保护。可用 `!` 或 `!!` 执行离线命令，`!!` 的输出不进入模型上下文。退出后不会保存这次沙箱会话。MCP、扩展、项目资源自动发现、附件、工作树管理及 RPC/T3 不可用。缺少 Seatbelt 或启动检查失败时，Codey 会停止。 [macOS 详细边界](../../codey/sandbox/macos/README.md)

在带有本地 `.git` 目录的仓库根目录运行沙箱，输入 `/review` 可流式审查暂存、未暂存和未忽略的未跟踪文本改动。审查使用项目的忽略规则和 `.git/info/exclude`。收集改动的 Git worker 只能读取工作区和指定 Git 元数据，模型经宿主收取有大小限制的补丁，审查轮没有工具。结果直接显示在当前对话，Ctrl+C 可中止并继续输入。Linked worktree、带基准分支的审查、受保护文件、符号链接和非文本改动不受支持。请把其他敏感资料放在工作区外。普通模式 `/review` 仍支持原有范围。

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
