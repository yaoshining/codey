# 登录与模型

[返回手册](README.md)

在普通 `codey` 中运行 `/login`，从菜单列出的服务商中选择账户登录或 API key 登录。已有账户登录和 API key 由 Codey 本地保管。运行 `/model` 选择可用模型。`/logout` 移除已保存凭据，环境变量提供的密钥继续生效。

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
