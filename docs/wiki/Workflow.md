# 计划、审查、工作树与 T3

[返回手册](README.md)

## 结构化提问

普通 Codey 交互终端和 Plan 模式都可以在当前轮询问需求或偏好。每次显示一个简短问题和 2–4 个带说明的选项，可能标记推荐项。初始焦点在取消，推荐项需要你主动选择。也可以输入自己的答案。选完还需选择 `Send answer`，关闭或取消不会替你作答。确认后答案回到当前轮和模式。该交互不授予权限，也不会切换模式。要求精简工具时，可在工具列表中保留 `ask_user`。

macOS Seatbelt 终端同样支持提问。输入选项编号或选择自定义答案，核对内容后输入终端显示的本次确认码。直接按 Enter 或用 Ctrl+C 可以取消。

普通 Pi RPC、沙箱 Pi RPC、打印和 JSON 入口以文字列出选项后结束本轮，可在下一条聊天消息中回答。文字回复按正常消息处理。Local ACP 客户端在握手时声明支持 ACP 表单，就可以显示选项及自定义答案，由客户端提交后继续本轮。未声明表单支持的 T3、Y3Code 或其他 ACP 客户端使用相同的文字回退。取消或超时后，迟到的表单答复会被丢弃。Linux Docker 沙箱入口未接入这项交互。

## Plan 模式

在普通 Codey 交互终端输入 `/plan` 进入 Plan 模式，也可以直接输入 `/plan <任务>`。底栏显示 `Plan · read-only`。像平常一样回答澄清问题，计划会显示在当前对话。对话里的「开始实现」仍按规划请求处理。

Plan 的模型请求仅提供工作区目录浏览与小型文本文件读取。它跳过符号链接、隐藏目录和常见凭据路径，不调用 shell、普通写工具、扩展工具或 MCP。对话会显示探索状态与成功检查次数。单个路径不可读时可继续检查。遇到未声明工具或耗尽探索预算时，Codey 会用同一个模型、原始任务和已取得的观察做一次无工具收尾，请模型说明待确认的信息。读取的文本会发给你所选的模型。Codey 继续通过普通会话记录展示规划对话。

用配置的中断键取消当前请求。`/plan cancel` 丢弃规划上下文并留在只读模式。要实施，输入 `/plan execute` 并选择切换，之后再提交一条明确的执行请求。切换只恢复进入 Plan 前的工具，不会立即请求模型或执行计划。已保存的 Plan 会话恢复为只读，也不会自动运行。全新的 Plan-only 会话沿用 Pi 的保存规则，尚无普通对话时可能没有可恢复的会话文件。

首版仅支持普通 Codey 交互终端。T3/Y3Code、ACP、Pi RPC、打印／JSON、macOS Seatbelt 终端和 Linux Docker 沙箱均未接入。普通终端的 Plan 工具限制针对模型，进程内已安装的可信扩展仍由普通 Codey 加载。

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

**Permissions 菜单尚未接线。** T3 Beta 0.1.13 的 Local command adapter 不会把主界面的四档选择发送给 Codey。原有 `--sandbox=workspace-write` 启动参数下，即使界面显示 Supervised，工具仍可编辑工作区内允许写入的文件。如果需要固定只读，另建一条使用 `acp` 和 `--sandbox=read-only` 的 Local command 配置，再新建聊天。Codey 按启动配置执行，工具网络始终关闭。[ACP 权限选项](Sandbox.md#acp-权限)

在 T3 设置中刷新此 provider，可读取普通 Codey 已配置的模型和每个模型的推理档位。通过 `/provider` 添加的模型在 ACP 列表中直接显示网关模型 ID，例如 `openai/gpt-6.2-sol`，选择仍使用包含 provider 的完整 ID。设置页从 T3 服务目录探测模型和个人技能名称、描述。要开始对话，请打开实际项目，让 Codey 在该项目启动 Seatbelt。

Codey ACP 在 `configOptions` 的模型选项与兼容的 `models.availableModels` 条目中提供可选扩展 `_meta["com.github.yaoshining.codey/subProvider"]`。值是 `{ "id": "litellm", "displayName": "LiteLLM" }` 这类对象，来自已通过校验的 `/provider` 配置。`displayName` 可供客户端画尾标。Settings 探测和普通会话使用相同字段，模型 `name` 保持 `openai/gpt-6.2-sol`，选择值仍是 `litellm/openai/gpt-6.2-sol`。扩展仅包含提供商 ID 和显示名。当前 T3 Local ACP adapter 尚未映射该扩展，需要客户端接入后才有灰色尾标。

#### 在 T3 中使用 Codey 技能

- 个人技能可放在 `~/.agents/skills/<name>/SKILL.md` 或 `~/.codey/agent/skills/<name>/SKILL.md`，同名时优先使用 Codey 目录。刷新 Local ACP provider 后，在对话框输入 `$` 查找并点选技能。如果 T3 已开启在 `/` 菜单显示技能，也可从那里点选。
- 项目技能放在所选工作区根目录的 `.agents/skills/<name>/SKILL.md`。在实际项目聊天发送 `$project-skills`，即可在当前对话内列出项目技能，无需请求模型。发送 `$<name>` 使用技能。当前 T3 Local ACP 菜单按 provider 共用，因此菜单只显示个人技能和同一个项目列表入口。
- `SKILL.md` 的 YAML 头需有 `name` 和 `description`，名称须与目录相同，使用小写 ASCII 字母、数字和连字符，最多 64 字符。`user-invocable: false` 的技能不会加载。同名时已可用的个人技能优先，其次是当前项目的技能，最后才是待核准提示。把 `$<name>` 放在消息开头可传参，如 `$draft-notes 修订第二段`。正文中的 `$ARGUMENTS` 会替换为字面参数。消息中间的 `$<name>` 只选取技能，整条消息仍作为请求。
- 所选正文随本轮用户消息发送给所选模型。Seatbelt 从工作区读取项目技能，目录链接的最终目标必须在当前工作区内，`SKILL.md` 须为普通文件。单文件上限 48 KiB，菜单最多列 64 项。普通终端和 Pi RPC 沿用各自的技能机制。
- 个人技能目录链接可自动指向上述两个个人技能根目录内的技能。个人目录和文件须归当前用户所有，且群组和其他用户无写权限。外部目录链接须单独核准，见下方。损坏、循环或越界链接会被跳过。
- 从其他 provider 切到 Codey ACP 后，`$project-skills` 仍在本地执行，交接历史保留给下一次模型请求。若 T3 文本中出现多个交接分隔符，Codey 将整段作为普通对话内容处理。

**核准外部个人技能链接。** 符合文件类型、所有者和大小限制的个人外链会自动出现在 T3 技能菜单，标为 `approval required before use`。占位条目只使用链接名和固定说明。点选后 Codey 会在本地显示核准步骤，本轮不会调用模型。运行 `codey acp skills inspect <name>` 查看链接当前指向的 `SKILL.md` 和 SHA-256。核对内容和来源后，运行 `codey acp skills trust <name> '<输出中的 path>' '<输出中的 sha256>'`，刷新 T3 Local ACP provider，再重新连接 ACP 会话。路径含空格时请加引号。审批只适用于精确文件和字节内容，内容或目标变化会恢复为待核准。用 `codey acp skills untrust <name>` 撤销旧核准。外部文件须归当前用户所有，且不能有 `other` 写权限。

技能正文提供提示。Codey ACP 跳过动态 shell 模板，也不会加载任何技能脚本、插件、钩子或浏览器工具。Codex 的管理员目录、祖先目录扫描及 Claude Code 的 `.claude/skills` 分发不属于 Codey ACP 的发现范围。

ACP 接入**不会让模型读到 T3 跨线程引用的正文**。引用以客户端实际传入的文字或 URI 为准，Codey 不打开链接，也不接入 T3 附带的 MCP。若需要本轮模型查看另一条聊天的内容，可把你允许分享的摘录直接贴进当前聊天。后续读取工具需要验证 T3 能否把授权绑定到本轮由用户选中的那一条引用，并限制可返回的数据范围。
