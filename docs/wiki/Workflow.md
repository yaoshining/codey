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

沙箱首版支持模型选择、文本对话、流式响应、取消及同工作区会话恢复。T3 自动附带的扩展不加载，T3 的审批交互、浏览器、附件、服务档位和跨工作区恢复不受支持。启用后，原有普通 Pi 会话应继续用普通入口打开。 [沙箱 RPC 边界](Sandbox.md#macos-沙箱-rpc-与-t3)
