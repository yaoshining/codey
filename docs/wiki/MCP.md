# MCP 与证书

[返回手册](README.md)

普通 Codey 的用户级 MCP 服务默认配置在 `~/.codey/agent/mcp.json`。项目级配置使用 `.pi/mcp.json`，受项目可信规则限制。运行 `/mcp` 查看状态、登录或重连。 [MCP CLI 帮助](../../packages/coding-agent/docs/mcp.md)

## 只为指定端点信任自签证书

若全局服务报 `fetch failed` 或 `MCP TLS certificate is untrusted`，从管理员处取得 CA 公共证书，或取得自签名服务的公共证书。通过可信渠道另行核验 SHA-256 指纹。在默认用户目录把公共 PEM 保存为 `~/.codey/agent/mcp-cas/gateway.pem`，并在 `~/.codey/agent/mcp-ca.json` 写入以下条目。服务名和完整 URL 必须与全局 `mcp.json` 一致。

```json
{
  "internal-tools": {
    "url": "https://192.0.2.10:8443/mcp",
    "caFile": "gateway.pem"
  }
}
```

文件和目录应由当前用户持有，组用户及其他用户不能写入。配置应位于工作目录之外。重启普通 Codey，再运行 `/mcp`。撤销信任时删除对应条目并重启。若提示 `MCP TLS identity mismatch`，确认 URL 的 DNS 名称或 IP 确切出现在证书的对应 SAN 中。IP URL 要使用 IP SAN。

信任范围仅为这一服务和端点。浏览器 OAuth、其他服务与独立 `codey mcp` 子命令使用各自的验证机制。此设置不能为模型网关配置 CA。macOS Seatbelt 会话目前不支持 MCP。 [详细配置](../../codey/README.md#trust-a-ca-for-one-mcp-endpoint)
