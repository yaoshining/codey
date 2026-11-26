# 审查、工作树与 T3

[返回手册](README.md)

## 审查改动

| 命令 | 范围 |
| --- | --- |
| `/review` | 暂存、未暂存及 Git 未忽略的未跟踪文件 |
| `/review main` | 本地 `main` 和 HEAD 的共同祖先到 HEAD 的已提交改动 |
| `/review origin/main` | 使用本地已存在的 `origin/main` 引用，审查已提交改动 |

审查开始与结束标记出现在对话区。它将一次有界的 diff 交给所选模型，按优先级汇报问题和文件行号。它不写审查文件、工作树或索引。在线模型可能收到未发布代码并产生费用。输入上限为 64 KiB 和 100 个未跟踪文件，过大时请缩小范围。终端中可以按 Esc 或当前配置的中断键取消。 [审查详情](../../codey/README.md#review-changes)

## 工作树

在普通终端里输入 `/worktree`，可以把当前对话复制到新工作树、开启空白会话，或浏览工作树。切换目录需要已保存的会话。原目录的暂存、未提交文件和旧会话留在原处。默认目录为 `~/.codey/worktrees/<随机 ID>/<项目名>/`。

```bash
codey worktree fix-tests --base main
codey worktree list
codey worktree delete <id>
```

创建命令从指定基准的已提交状态开始，默认基准是 `HEAD`。删除保留分支，只适用于 Codey 管理的工作树。当前目录位于工作树根或子目录时无法删除，有改动的工作树也会保留。工作树与原仓库共享 Git 对象和引用。需要隔离文件权限时另选沙箱。 [更多工作树用法](../../codey/README.md#work-in-a-separate-git-checkout)

## T3 Code

在 T3 Code v0.1.11 的 Pi provider 设置中，**Binary path** 填运行 T3 服务的机器上 `codey-t3` 的绝对路径，默认 `~/.local/bin/codey-t3`。这里的 `~` 应替换成实际家目录。保存并刷新 provider。这个入口让 T3 的 `--version` 探测读到 Pi 运行时版本，平时调用仍用 Codey 的配置与 RPC。远程使用时，客户端本机的安装路径可能与 T3 服务端不同。[T3 设置详情](../../codey/README.md#t3-code-v0111)

在运行 T3 服务的 Mac 上，可为 Pi provider 的 **Launch arguments** 加入 `--sandbox=workspace-write`，继续使用上述 `codey-t3` 路径。T3 会加上 `--mode rpc`。沙箱使用 T3 启动进程时指定的项目目录，由 Codey 的 Seatbelt 规则约束工具。请在普通 `codey` 完成登录。

启用沙箱后，请在同一个项目新建一条**空白聊天**。后续保持沙箱启动参数和工作目录，打开这条聊天即可恢复，哪怕上次还没发出第一条消息。已有普通 Pi 或 Codey 聊天请继续用普通入口打开。旧聊天不会自动迁移或清空。

如果旧聊天显示 `Starting Pi` 后报 `Pi transport closed during status reset`，请查看 T3 服务日志中在它之前的 `switch_session` 错误，再确认该聊天是否由沙箱在当前工作目录创建。模式或目录不匹配时，可在沙箱里新建空白聊天，把原聊天留在原来的模式和目录。

沙箱支持模型选择、文本对话、流式响应、取消和同工作区恢复。T3 的审批交互、浏览器、附件、服务档位、扩展和跨工作区恢复目前不可用。[沙箱 RPC 边界](Sandbox.md#macos-沙箱-rpc-与-t3)

### T3 的 ACP Local command

在运行 T3 服务的 Mac 上，添加 **ACP Provider → Local command**。在 **Executable** 填 `codey` 的绝对路径，例如 `/Users/yourname/.local/bin/codey`。在 **Arguments** 中分两行填 `acp` 和 `--sandbox=workspace-write`。先在普通 Codey 用 `/login` 配好模型，再回 T3 新建一条使用此 ACP provider 的空白聊天。T3 服务的 PATH 需要包含 Node.js。

Codey 通过 stdio 协商 ACP v1，支持文本流、模型和推理档位、停止对话以及在同一工作目录恢复。ACP 会话与 Pi RPC 和普通 Codey 会话分开保存。使用相同的 provider 和工作目录重新打开已建立的 ACP 聊天即可续接。

在 T3 设置中刷新此 provider，可读取普通 Codey 已配置的模型和每个模型的推理档位。通过 `/provider` 添加的模型在 ACP 列表中直接显示网关模型 ID，例如 `openai/gpt-6.2-sol`，选择仍使用包含 provider 的完整 ID。设置页的探测可以从 T3 服务目录运行，且只返回模型信息。要开始对话，请打开实际项目；工具仍需要在该项目启动 Seatbelt。

ACP 接入**不会让模型读到 T3 跨线程引用的正文**。引用以客户端实际传入的文字或 URI 为准，Codey 不打开链接，也不接入 T3 附带的 MCP。若需要本轮模型查看另一条聊天的内容，可把你允许分享的摘录直接贴进当前聊天。后续读取工具需要验证 T3 能否把授权绑定到本轮由用户选中的那一条引用，并限制可返回的数据范围。
