# 登录与模型

[返回手册](README.md)

在普通 `codey` 中运行 `/login`，从菜单列出的服务商中选择账户登录或 API key 登录。已有账户登录和 API key 由 Codey 本地保管。运行 `/model` 选择可用模型。`/logout` 移除已保存凭据，环境变量提供的密钥继续生效。

## 用 `/provider` 添加或编辑连接

在普通终端的 Codey 中运行 `/provider`。选择 **Add provider**，输入服务商名称，再选 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。填网关提供的 Base URL，并独立选择 **API Key** 或 **No authentication**。默认使用 HTTPS，公网端点必须使用 HTTPS。数字回环地址 `127.0.0.1` 或 `[::1]` 的本地开发服务可以直接用 HTTP。

名称可用 ASCII 大小写字母，最多 40 个字符，以字母开头，后续可用字母、数字、连字符和下划线。例如，输入 `LiteLLM` 会保留显示名，内部 ID 为 `litellm`。`/provider` 会显示名称和 ID，`/model` 的模型标签可以显示 `LiteLLM/模型ID`，服务商徽标仍显示内部 ID。文件名、默认模型设置和 `codey --provider litellm` 使用小写 ID。大小写写法共用同一个 ID，已被自定义服务商、内置服务商或已保存登录占用的 ID 无法再次添加。

可以选择 **Discover via the model catalog** 读取模型目录。向导会沿同一目录地址分页并去重，无需选中所有模型。搜索会先显示完整 ID 匹配，再显示前缀和其他包含匹配。目录只表示网关公布的模型 ID。遇到请求中断或保护上限时，会标明已加载条数；若能从断点继续，选择 **Continue loading model catalog**，也可从头重试。一次最多保存 500 个选中的模型。

端点没有目录、目录请求失败或想追加别名时，选择 **Enter model IDs manually**，填单个 ID 或 JSON 数组，例如 `["model-a", "model-b"]`。向导不会发送聊天请求。保存后用 `/model` 选择；若目录还在刷新，可执行一次 `/reload`。

用 **Edit provider or models** 修改端点、协议、认证或模型列表，用 **Replace API key** 换密钥。端点或协议变更时，填入新连接的密钥。保存前会显示修改范围，取消时不会写入。向导管理的配置和掩码录入的密钥保存在默认宿主目录 `~/.codey/agent/custom-providers/`，其中每个文件只供当前用户访问。`models.json` 和 `/login` 的标准凭据文件照旧。使用 `/provider` 管理这些连接的密钥。

用 **Rename display name** 为现有连接设置新的显示名，例如把 `litellm` 显示为 `NAS-LiteLLM`。显示名遵循上面的 ASCII 字符规则。多个连接可以使用同一显示名，选择时按括号里的 ID 区分。文件、默认模型、历史关联和命令行仍使用原来的 ID，例如 `codey --provider litellm`。

用 **Delete provider** 移除向导保存的连接、模型列表和随连接保存的密钥及 LAN HTTP 授权。确认菜单默认选中 **Cancel**。若该连接是当前模型或默认模型，请先在 `/model` 亲自切换，必要时设为新的默认模型。如果已将它限定在会话的模型范围内，先在 `/scoped-models` 移出这些模型。这个入口只管理 `/provider` 保存的连接，其他已打开的 Codey 实例重启后才会应用变更。

如果你的网关是 LiteLLM，OpenAI 协议通常填 `https://gateway.example.org/v1`，Anthropic Messages 通常填 `https://gateway.example.org`。模型 ID 填网关给出的别名。自定义连接的浏览器 OAuth 暂未开放。macOS Seatbelt 会话重新启动时可从可信宿主目录读取已保存的连接，向导仍在普通 Codey 中使用。

### 为现有模型配置推理档位

在普通 Codey 运行 `/provider`，依次选择 **Configure model reasoning**、已保存的连接和模型。只勾选网关确认支持的档位，例如 `low` 和 `high`，按界面底部的完成键并确认保存。然后用 `/model` 选中该模型，再用 `/thinking` 选档位。取消全部勾选并保存可以清除这个模型的配置。

OpenAI Responses 发送 `reasoning.effort`，可选 `minimal`、`low`、`medium`、`high`、`xhigh`、`max`。支持 OpenAI 格式的 Chat Completions 网关可配置 `low`、`medium`、`high`，使用 `reasoning_effort`。Anthropic Messages 的推理预算使用另一套参数，此菜单暂不支持。Codey 按模型保存支持档位，模型别名或目录结果不会自动开启推理。选 `off` 时请求省略档位，由网关决定默认行为。

更换协议或 Base URL 后，要为新路由重新选择支持的档位。其他正在运行的 Codey 或 T3 连接需重启以加载这份配置。普通 RPC 沿用 Pi 的档位回退规则，沙箱 RPC 会明确拒绝不支持的档位。

### 读取和调整模型上下文与输出上限

在普通 Codey 的 `/provider` 中选择 **Configure model limits**，选已保存的连接与模型。添加或编辑连接时，选好模型后也可以进入此菜单。每一项会显示当前值及来源。**Read gateway limits** 会用当前连接查看目录，缺项时尝试同一 Base URL 下的 `/model/info`。只匹配模型的完整路由 ID。查不到的项会标为未知，继续使用兼容默认值 32,000（上下文）和 4,096（输出）。

上下文上限是输入与输出合计的 token 数。目录里的 `max_input_tokens` 只说明输入上限，Codey 不把它换算成上下文。Codey 接受语义明确的 `context_window` 或 `context_length`、`max_output_tokens`，以及部分已知目录的输出字段，例如 Anthropic 模型目录的 `max_tokens`。普通 OpenAI 模型列表可能只有模型 ID。 [OpenAI 模型列表](https://developers.openai.com/api/reference/go/resources/models/methods/list) · [Anthropic 模型目录](https://platform.claude.com/docs/en/api/models/list) · [LiteLLM 模型管理](https://docs.litellm.ai/docs/proxy/model_management)

用 **Edit context window** 和 **Edit output limit** 分别填写整数，清空对应输入可恢复自动。手动值优先，重新读取目录不会覆盖它。确认保存后，其他已运行的 Codey、RPC 或 ACP 会话可通过重新启动使用新值。输出还受当前可用上下文约束，接近窗口时请求预算可能低于所填的上限。沙箱 RPC 和 ACP 沿用现有的上下文压缩设置。

### 局域网 LiteLLM 使用 HTTP

在向导里填写如 `http://192.168.1.20:4000/v1` 或 `http://nas.local:4000/v1`。首次使用时会显示完整地址并请你确认。确认后，API key、提示词、代码和响应会以明文传输。直接选择 **Discover via the model catalog** 即可获取模型列表，保存后可正常推理。换主机、端口或 Base URL 路径需要重新确认。取消确认不会发送请求或保存变更。

HTTP 支持标准 RFC1918 私网 IPv4、IPv6 ULA、回环和普通主机名，包括 `nas`。每次建立连接时，主机名的所有解析结果都必须位于允许的内网或回环范围。混有公网地址、链路本地、CGNAT、组播和混淆 IP 写法都会被拒绝。连接直接拨号并保留原 Host，无代理或重定向。

## 手动配置自定义网关

将下面的示例合并进 `~/.codey/agent/models.json` 的 `providers` 对象，保留原有条目。为每一条连接选择全新的 provider ID，避免覆盖内置服务商。配置自定义网关时使用它自己的密钥。示例域名和模型名是占位符。

```json
{
  "providers": {
    "litellm-chat": {
      "baseUrl": "https://gateway.example.org/v1",
      "api": "openai-completions",
      "apiKey": "${CODEY_GATEWAY_KEY}",
      "models": [{ "id": "coding-assistant" }]
    },
    "litellm-messages": {
      "baseUrl": "https://gateway.example.org",
      "api": "anthropic-messages",
      "apiKey": "${CODEY_GATEWAY_KEY}",
      "models": [{ "id": "coding-assistant" }]
    }
  }
}
```

只添加你实际需要的协议。OpenAI 兼容 Chat Completions 示例的完整请求路径是 `/v1/chat/completions`。Anthropic Messages 客户端会追加 `/v1/messages`，所以示例 Base URL 不带 `/v1`。如果管理员给的网关有前缀，保留前缀。`models[].id` 要填网关接受的别名，LiteLLM 通常是管理员配置的 `model_name`。使用已知且证书有效的 HTTPS 端点。从自己的密钥管理器为启动 Codey 的环境提供 `CODEY_GATEWAY_KEY`，JSON 中保留变量引用。 [LiteLLM 客户端配置](https://docs.litellm.ai/docs/proxy/client_setup/overview) · [LiteLLM Messages](https://docs.litellm.ai/docs/anthropic_unified/) · [Pi 模型配置字段](../../packages/coding-agent/docs/models-configuration.md)

关闭并重启 Codey，在 `/model` 中选 `litellm-chat/coding-assistant` 或 `litellm-messages/coding-assistant`。普通选择只影响当前会话。要设为今后新会话的默认模型，请用选择器底部 `set as default` 显示的快捷键。也可以在 `~/.codey/agent/settings.json` 合并以下字段，或用 `codey --provider litellm-chat --model coding-assistant` 为本次启动指定模型。

```json
{
  "defaultProvider": "litellm-chat",
  "defaultModel": "coding-assistant"
}
```

- **`No models available`**：检查 JSON 语法、配置目录、model ID 和启动环境里是否已设置变量。macOS 沙箱应先退出，修正普通 Codey 的配置再重开。
- **`401` 或 `403`**：确认用的是网关密钥，并允许访问所选模型。
- **`404`**：核对 Base URL、协议及别名。不要把完整请求路径填成 Base URL。
- **TLS 错误**：核对证书链和主机名。MCP 专用证书设置只适用于 MCP 服务。 [MCP 证书](MCP.md)
