# MCP 与证书

[返回手册](README.md)

普通 Codey 的用户级 MCP 服务默认配置在 `~/.codey/agent/mcp.json`。项目级配置使用 `.pi/mcp.json`，受项目可信规则限制。运行 `/mcp` 查看状态、登录或重连。 [MCP CLI 帮助](../../packages/coding-agent/docs/mcp.md)

## 添加直连 HTTPS 服务

在普通 Codey 的 `/mcp` 菜单选择 **Add direct HTTPS server**，或输入 `/mcp add`。输入服务名和完整 HTTPS MCP 地址。证书正常受信任时直接添加，无需确认指纹。

如果服务使用不受信任的自签名证书，Codey 会显示地址与 SHA-256 指纹。通过 NAS 管理后台或管理员等可信渠道取得指纹，核对完全匹配后选择 **Fingerprint matches — trust and add this service**。取消添加不会保留证书或服务。Codey 会重新验证指纹、有效期和 SAN，使用 IP 地址时证书必须包含匹配的 IP SAN。自建 CA 签发的服务请使用下文的手工 CA 配置。

若服务要求身份验证，添加后会出现 **Open browser to sign in**。也可选 **Later**，之后从 `/mcp` 菜单登录，或运行 `/mcp direct login <名称>`。向导的 OAuth 登录支持动态客户端注册。需要固定客户端或特殊 OAuth 设置的服务可继续使用手工配置。Codey 的信任只适用于保存的 MCP 地址和此服务的同源 OAuth 请求。跨源 OAuth 有独立的确认和 TLS 校验。浏览器使用自己的信任设置，若提示证书错误，应在浏览器外核对并按管理员指引处理后再继续。

向导添加的服务保存在 `~/.codey/agent/mcp-direct`。证书更换需要重新核对。运行 `/mcp direct remove <名称>` 删除旧条目和该服务的本地授权，再用向导添加。此流程不会更改钥匙串或现有手工 MCP 配置。

## 通过本地 Node 桥接单个服务

普通 Codey 默认使用 Streamable HTTP 直连和 Node 的正常 TLS 验证，无需单独提供证书。需要本地 Node 子进程时，在项目目录启动普通 `codey`，输入 `/mcp bridge`，选择 `Add Node bridge`。也可以直接输入 `/mcp bridge add`。

1. 输入未被占用的服务名和完整 HTTPS MCP URL，例如 `https://mcp.example.org/mcp`。服务名支持 ASCII 大小写，界面保留录入的拼写。仅大小写不同，或仅连字符与下划线不同的名称会冲突。
2. 默认选 **Use Node and system trust**，无需证书文件。只有默认验证报不受信任时，才需要选 **Choose a verified public PEM for this endpoint**。使用管理员提供的公共 CA 或自签名服务证书，核对确认页上的 URL 和经可信渠道取得的 SHA-256 指纹。
3. 如果管理员给了适用于该端点的 Bearer token，可以填写启动 Codey 的环境变量名。没有 token 时留空。不要把 token 或私钥填进向导。
4. 确认后用 `/reload` 或重启普通 Codey，再打开 `/mcp` 查看。一个服务只对应一个 HTTPS 端点，证书链、有效期和主机名或 IP SAN 都会校验。桥接不跟随重定向。

`/mcp bridge list` 查看已保存条目，`/mcp bridge remove` 删除，随后重启或 `/reload` 关闭活动连接。配置保存在默认用户目录的 `mcp-bridges`，每个桥接单独一份，项目配置不能添加桥接。Node 子进程使用 Codey 已有依赖，不需要另装脚本或 npm 包。

### 为桥接服务登录 OAuth

如果桥接报 `401`，对需要 OAuth 的服务请在添加时把 Bearer token 环境变量留空。运行普通终端的 `/mcp bridge login`，选择该桥接。当元数据、唯一发行方和登录端点与 MCP 服务同源时，Codey 会直接打开系统浏览器。浏览器完成同意后回到 Codey，再用 `/reload` 或重启。用 `/mcp` 查看连接。登录不需要静态 client ID 或 secret，等待浏览器时可以取消。

如果服务列出多个发行方，Codey 会要求选择。跨源读取元数据需要单独同意，读取时不发送 OAuth 凭据。跨源浏览器页面、客户端注册或令牌端点会集中列出并要求批准。这个选择只用于此次登录，保存的授权只能用其绑定的端点刷新。本地回调只监听 `127.0.0.1`，使用 PKCE 并验证 `state`。保存的令牌与桥接名称、HTTPS 服务地址和所选信任选项绑定。已有桥接、CA 和令牌可继续使用。

显式选定的私有 CA 只在原服务 origin 的 Node 客户端生效。桥接的正常验证读取 Node 和系统信任，浏览器使用自身的证书信任。浏览器出现证书异常时先修复该地址的信任。Codey 不修改信任库或导入其他客户端的配置，也不跟随 OAuth HTTP 重定向。

`/mcp bridge logout` 清除该桥接的本地登录，随后 `/reload` 或重启关闭旧会话。这个操作不做服务端撤销。独立 Bearer 和普通直连 `/mcp` 保留原有路径。Pomodoist 官方文档描述了这种动态注册登录方式，Codey 当前用合成服务验证，尚未连接真实实例。 [Pomodoist 自托管说明](https://pomodoist.com/docs/self-hosting/#connect-an-mcp-client)

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
