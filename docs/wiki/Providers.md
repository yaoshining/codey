# 登录与模型

[返回手册](README.md)

在普通 `codey` 中运行 `/login`，从菜单列出的服务商中选择账户登录或 API key 登录。已有账户登录和 API key 由 Codey 本地保管。运行 `/model` 选择可用模型。`/logout` 移除已保存凭据，环境变量提供的密钥继续生效。

## 用 `/provider` 添加或编辑连接

在普通终端的 Codey 中运行 `/provider`。选择 **Add provider**，输入一个未占用的 provider ID，再选 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。填网关提供的 Base URL，并独立选择 **API Key** 或 **No authentication**。默认使用 HTTPS，公网端点必须使用 HTTPS。数字回环地址 `127.0.0.1` 或 `[::1]` 的本地开发服务可以直接用 HTTP。

可以选择 **Discover via the model catalog** 并确认一次目录请求。结果支持搜索和多选，屏幕底部显示切换选中与完成的快捷键。列表只表示目录公布的模型 ID。端点没有目录、目录请求失败或想追加别名时，选择 **Enter model IDs manually**，填单个 ID 或 JSON 数组，例如 `["model-a", "model-b"]`。向导不会发送聊天请求。保存后用 `/model` 选择；若目录还在刷新，可执行一次 `/reload`。

用 **Edit provider or models** 修改端点、协议、认证或模型列表，用 **Replace API key** 换密钥。端点或协议变更时，填入新连接的密钥。保存前会显示修改范围，取消时不会写入。向导管理的配置和掩码录入的密钥保存在默认宿主目录 `~/.codey/agent/custom-providers/`，其中每个文件只供当前用户访问。`models.json` 和 `/login` 的标准凭据文件照旧。使用 `/provider` 管理这些连接的密钥。

如果你的网关是 LiteLLM，OpenAI 协议通常填 `https://gateway.example.org/v1`，Anthropic Messages 通常填 `https://gateway.example.org`。模型 ID 填网关给出的别名。自定义连接的浏览器 OAuth 暂未开放。macOS Seatbelt 会话重新启动时可从可信宿主目录读取已保存的连接，向导仍在普通 Codey 中使用。

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
