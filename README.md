# dsh-web-search-moonshot

用 **Moonshot / Kimi 联网搜索 Basic（`POST /v1/tools/search`）** 作为 DeepSeek Harness `ctx.web` 的搜索提供方。

内建的 `dsh-web-search-deepseek` 是「Anthropic 兼容 Messages + `web_search` 服务端工具」适配器：一次搜索要跑一整轮模型、花生成 token。本包不是那个协议——它把 `web_search` 工具的一次查询直接变成 Kimi 工具接口的一次调用，返回结构化结果，**不发模型请求、不计生成 token**。

## 它做什么

```
web_search tool ──▶ ctx.web seam ──▶ moonshot provider ──▶ POST https://api.moonshot.cn/v1/tools/search
                                                              { text_query, limit, timeout_seconds }
```

字段映射（`search_results[]` → `WebSearchSource`）：

| Kimi 字段 | seam 字段 | 说明 |
| --- | --- | --- |
| `url` | `url` | 必填；非绝对 http(s) 链接直接丢弃，按 URL 去重 |
| `title` | `title` | 空值不产生字段 |
| `snippet` | `snippet` | 空值不产生字段 |
| `date` | `publishedAt` | 空值不产生字段 |
| `authority` / `icon` / `mime` / `site_name` / `text` | — | 不映射 |

`limit` 取自接缝传入的 `maxResults`（夹到接口允许的 1–20）；最终条数上限仍由 seam 收敛。

## 安装

```sh
# 路径换成你本地克隆本仓库的位置
git clone git@github.com:alfred-zhong/dsh-web-search-moonshot.git
dsh plugin --profile desktop add /Users/alfred/Workspace/github.com/alfred-zhong/dsh-web-search-moonshot
```

`dsh plugin` 在 pnpm 成功后会把本包登记进 profile 的 `dsh.profile.bundles`，于是 `cordis.patch.yml` 这层补丁生效：

- `insert` 一行 `web-search-moonshot`（注册提供方）；
- 覆盖内建 `web` 行，把 `searchProvider` 指到 `moonshot`（保留 `fetchProvider: http`）。

补丁含 config 行，**不能热挂载**：装完需要重启 DSH 才生效。

### 为什么必须声明 `peerDependencies`

`dsh plugin add <目录>` 装成的是 `link:`（符号链接）。宿主 `dsh-app-boot` 的 `routeLinked` 规则是：**链接安装的插件，只有把要导入的宿主包写进自己的 `peerDependencies`，该导入才会被路由到宿主自带的副本**；否则退回原生 `node_modules` 查找——而仓库目录往上根本没有 `@deepseek-ai/*`，结果是这行插件在启动时报 `failed to import`，`searchProvider` 却已经切到 `moonshot`，最终表现为 `configured web provider "moonshot" is not registered`。

所以 `package.json` 里这四个 peer 不是装饰，删掉就会坏：`@deepseek-ai/dsh-web`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-launch-environment`、`@deepseek-ai/schemastery`。已装的社区插件（如 `dsh-mcp-client`）同样是「导入什么就声明什么 peer」。版本按宿主运行时来（当前 `0.2.0-rc.2`；`@deepseek-ai/dsh-*` 会被启动时的兼容性检查比对，`schemastery` 不在检查范围内）。

卸载：

```sh
dsh plugin --profile desktop remove dsh-web-search-moonshot
```

## 在 GUI 里单独配置 Key

客户端半边 `client.js` 在「设置 → 插件」里挂了两处配置入口，都写同一把凭据引用：

| 槽位 | key | 出现位置 |
| --- | --- | --- |
| `plugins.bundle.config` | `dsh-web-search-moonshot`（包名） | 已安装分组 → 本 bundle 详情页的配置区 |
| `plugins.row.config` | `dsh-web-search-moonshot#web-search-moonshot`（`包名#行id`） | 该插件那一行的「配置」入口 |

第二个 registration 不是可选的：插件管理页用 `configure.has(row)` 判断是否给某行显示「配置」按钮，而它的判据就是 `plugins.row.config` 里有没有这个 key。

卡片只有一个字段（API Key）加已配置/未配置徽标，保存时经官方客户端通道 `ctx.remote.credentials.set(ref, value)`（清空用 `unset(ref)`，状态用 `describe([ref])`）写进 `~/.dsh/.credentials.yaml` 的 `refs.MOONSHOT_API_KEY`——正好是宿主半边解析链的第 2 级，所以**保存后下一次搜索立即生效，不需要重启**；「清空」会删掉该引用，回退到 Kimi Code CLI 配置。凭据变化事件用 `credentials/reference-updated`（0.2.0-rc.2 实际发出的就是它，社区插件里那个 `credentials/updated` 在本版本不会触发）。

客户端半边不 import 任何 `@deepseek-ai/*`（`react`、槽位、locale、连接 API 全由 shell 通过 `window.__ModuleLoader__` 的 require 提供），样式只用主题变量且带字面值兜底。手写的 ModuleLoader 包装，无构建步骤；`module id` 必须是包名，否则 shell 找不到入口。

内置的「网页搜索」卡片走的是 `plugins.item` + `configForms` + `ui-primitives` 那套。`plugins.item` 属于插件管理页的**官方分组**（渲染的是部署自带能力），profile 插件挂上去会出现在错误的组里，所以这里走已安装插件专用的两个槽位。

## 配置

行 id `web-search-moonshot`（`cordis.patch.yml`）：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKey` | 未设置 | 字面值 Key，优先级最高；不建议写进配置 |
| `apiKeyEnv` | `MOONSHOT_API_KEY` | 凭据服务/启动环境里的引用名 |
| `baseURL` | `https://api.moonshot.cn/v1/tools/search` | 工具接口地址；**不要**追加 `/messages` |
| `timeoutSeconds` | `30` | 传给接口的 `timeout_seconds`（1–60） |
| `defaultLimit` | `10` | 调用方没给 `maxResults` 时的条数 |
| `includeContent` | `false` | 打开则请求 `include_content`，结果带网页正文（更贵更慢，且映射层不使用 `text`） |
| `readKimiCliConfig` | `true` | 允许从 Kimi Code CLI 配置兜底读 Key |

## Key 的解析顺序

每次搜索都重新解析，轮换 Key 不需要重启：

1. 配置里的 `apiKey` 字面值；
2. **凭据服务**里的 `apiKeyEnv`（默认 `MOONSHOT_API_KEY`）—— 挂载了凭据服务就以它为准，它自己再按「进程环境 → `~/.dsh/.credentials.yaml` 的 `refs:` → 项目/家目录 `.env` 快照」三层解析；
3. 仅当**没有**挂载凭据服务时，才回退到启动环境的同名变量；
4. `~/.kimi-code/config.toml`（其次 `~/.kimi/config.toml`）的 `[services.moonshot_search].api_key` —— **只读，从不写回**。

第 2 步的引用名不存在、第 1/3 步也拿不到值时，第 4 步让「已经配好 Kimi Code 联网搜索」的场景零配置可用。想砍掉第 4 步，把 `readKimiCliConfig` 设成 `false`；想让它排在别处之前，就在 `~/.dsh/.credentials.yaml` 的 `refs:` 下写一个 `MOONSHOT_API_KEY`。

本插件从不写入任何凭据文件。

## 错误码

沿用 `ctx.web` 的稳定错误码：

| 情况 | code |
| --- | --- |
| 一整条 Key 链都没解析到 | `WEB_PROVIDER_CREDENTIAL_MISSING` |
| 接口 401（Key 被拒） | `WEB_PROVIDER_CREDENTIAL_MISSING` |
| 其它 HTTP 失败、响应体不是 JSON、网络失败 | `WEB_PROVIDER_ERROR`（消息里带实际端点） |
| 调用方取消 | `WEB_ABORTED` |

已知的账号级失败：`/v1/tools/search` 可用但 `/v1/tools/search-pro` 返回 403 `The API you are accessing is not open`，说明该账号没开通联网搜索 Pro。本包只用 Basic。

## 开发

单文件、无构建、无运行时依赖（只用 harness 提供的包）：

```sh
node --check index.js     # 语法
node test/run.mjs         # 沙箱自测：桩掉 harness 包，真实打一次 Kimi 接口
```

`test/run.mjs` 会在临时目录里生成 `@deepseek-ai/*` 桩模块，把 `index.js` 与 `test/checks.mjs` 复制进去后运行，因此不需要 DSH 进程；覆盖结果映射、凭据链条、错误码与取消路径。第 3 项检查会真实请求 `api.moonshot.cn`（读本机 `~/.kimi-code/config.toml` 里的 Key）。
