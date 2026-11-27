# 安装与日常命令

[返回手册](README.md)

## 安装或更新

需要 macOS 或 Linux、Git、curl、tar、npm，以及 Node.js 22.19 或更新版本。取维护者给出的已审查 40 位提交 SHA，把下面两处 `FULL_COMMIT_SHA` 替换成同一个值。安装写入当前用户目录，无需 sudo。

```bash
(set -o pipefail; curl -fsSL https://raw.githubusercontent.com/yaoshining/codey/FULL_COMMIT_SHA/codey/install.sh | bash -s -- FULL_COMMIT_SHA) && export PATH="$HOME/.local/bin:$PATH"
```

看到安装成功后，进入项目目录启动 `codey`。更新时用新的已审查 SHA 重跑同一条命令。想回到先前版本，用那个版本的 SHA 重跑。`codey update` 的继承行为不能更新 Codey 安装目录。安装器默认把源码放在 `~/.local/share/codey/<commit>`，把入口放到 `~/.local/bin`。 [安装器详情](../../codey/README.md#install-a-reviewed-commit)

## 常用命令

| 输入 | 作用 |
| --- | --- |
| `codey` | 从当前目录开启交互会话 |
| `codey --help` | 查看命令行选项 |
| `codey --version` | 查看 Codey 版本 |
| `codey --pi-version` | 查看底层 Pi 运行时版本 |
| `codey --resume` | 选择一个已保存的会话 |
| `/login` | 配置已列出的模型服务商登录 |
| `/provider` | 添加或编辑自定义模型网关和模型 ID |
| `/model` | 选择当前会话的模型 |
| `/mcp` | 管理已配置的 MCP 服务 |
| `/review`、`/worktree` | 审查改动或管理工作树 |
| `/quit` | 退出 |

如果 shell 报 `command not found`，按安装输出执行 PATH 设置。如果登录正常但模型列表为空，检查启动的是否是 `codey`、配置是否在有效用户目录。普通模式默认使用 `~/.codey/agent`，显式 `--agent-dir <目录>` 优先于 `CODEY_CODING_AGENT_DIR`。安装器不会自动导入 `~/.pi/agent`。 [用户目录与手动共享](../../codey/README.md#user-directories-and-explicit-sharing)
