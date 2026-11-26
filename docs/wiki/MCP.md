# MCP 与证书

[返回手册](README.md)

普通 Codey 的用户级 MCP 服务默认配置在 `~/.codey/agent/mcp.json`。项目级配置使用 `.pi/mcp.json`，受项目可信规则限制。运行 `/mcp` 查看状态、登录或重连。 [MCP CLI 帮助](../../packages/coding-agent/docs/mcp.md)

## 通过本地 Node 桥接单个服务

普通 Codey 默认使用 Streamable HTTP 直连。需要使用本地 Node 子进程时，在项目目录启动普通 `codey`，输入 `/mcp bridge`，选择 `Add Node bridge`。也可以直接输入 `/mcp bridge add`。

1. 输入未被占用的服务名和完整 HTTPS MCP URL，例如 `https://mcp.example.org/mcp`。
2. 输入已有公共 CA 或自签名证书 PEM 的绝对路径。检查确认页上的 URL 与 SHA-256 指纹，与管理员通过可信渠道给出的值核对。
3. 如果管理员给了适用于该端点的 Bearer token，可以填写启动 Codey 的环境变量名。没有 token 时留空。不要把 token 或私钥填进向导。
4. 确认后用 `/reload` 或重启普通 Codey，再打开 `/mcp` 查看。一个服务只对应一个 HTTPS 端点，证书链、有效期和主机名或 IP SAN 都会校验。桥接不跟随重定向。

`/mcp bridge list` 查看已保存条目，`/mcp bridge remove` 删除，随后重启或 `/reload` 关闭活动连接。配置保存在默认用户目录的 `mcp-bridges`，每个桥接单独一份，项目配置不能添加桥接。Node 子进程使用 Codey 已有依赖，不需要另装脚本或 npm 包。

如果桥接报 `401`，说明服务拒绝了当前认证。桥接支持无认证或显式 Bearer token，浏览器 OAuth 仍走普通直连 `/mcp`。OAuth 服务需要管理员提供可用于桥接的 token，或用直连完成 OAuth。OAuth 发现和浏览器访问的其他地址需要各自的证书信任。桥接功能未在真实 Pomodoist 上验证。

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
