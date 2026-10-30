# dsh-plugin-outside-workspace

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）里，新建一个**不属于任何已注册工作区**的会话 —— 类似 Codex 的 projectless 会话 / 「不在工作区内工作」。

![新会话页的「不在工作区」按钮](docs/hero-button.png)

## 功能

- **入口**：空白新会话页（hero）工作区选择器右侧的「不在工作区 / Outside workspace」按钮；
- **工作目录**：默认落在 Host 的 `<文档>/deepseek-harness/outside-workspace`（缺失时由 Host 递归创建），
  例如 `C:\Users\<你>\Documents\deepseek-harness\outside-workspace`；
- **归属**：会话不注册工作区，侧边栏归入「未分组 / Ungrouped」；
- **首条消息**：DSH 原生在「空白且无工作区」时会禁用输入框，本插件接管 composer 提供首条消息输入
  （Enter 发送 / Shift+Enter 换行）；消息被接收后会话不再 blank，自动交还宿主的标准对话 UI 和 composer。

![工作区外会话的首条消息输入卡片](docs/composer-card.png)
![发送首条消息后交还宿主标准对话 UI](docs/after-first-message.png)

## 安装

在任意 DSH 会话里让 agent 使用 `plugin_manager` 工具安装本仓库（需要 Full access 权限）：

```text
plugin_manager({ action: "install_bundle", target: "github:realhenrylan/dsh-plugin-outside-workspace" })
```

也可以从本地目录安装：

```text
plugin_manager({ action: "install_bundle", target: "<本仓库 checkout 的绝对路径>" })
```

安装会写入当前 profile 的 `package.json`（依赖 + `dsh.profile.bundles`）。在开启 HMR 的 Desktop / Web
profile 里新装 bundle 会热生效；如果页面没有出现新按钮，手动刷新一次页面即可。
本地目录安装是 `link:` 安装，profile 的 `node_modules/dsh-outside-workspace` 指向该 checkout。

## 工作原理

- DSH 的 Client Session Controller 的 `ctx.sessions.create({ cwd })` 支持只给工作目录（与 `workspaceId`
  互斥），Host 会递归创建目录并把 `cwd` 记入 SessionHeader —— 所以「工作区外会话」无需改动 Host；
- 插件向宿主 UI 贡献两个 Slot：
  - `conversation.hero.options`（list）：hero 行里的「不在工作区」按钮，创建会话后
    `ctx.uiWorkspace.openSession(id)` 跳转过去；
  - `conversation.composer`（chain）：仅对「本插件刚创建的、仍为 blank 的」工作区外会话接管 composer，
    首条消息通过 `ctx.sessions.using(...)` 的 `binding.session.prompt([...], 'queue')` 发送；
- 默认目录推导：若存在宿主 first-use 的默认工作区（`<documents>/deepseek-harness/default-workspace`），
  沿用其 Documents 根（尊重 Host 的 `documentsDirectory` 配置）；否则取 `$host.home/Documents`。
  组合了 native directory picker 时 `directoryPicker/list` 不可用，首次点击会有一条预期的 fallback 警告。

## 已知限制（v1）

- 默认目录固定推导，暂未提供设置项；
- composer 接管只处理**首条纯文本消息**：不含附件、slash 命令、模型/推理档位选择；首条消息之后一切交还宿主；
- 页面刷新后，若仍停留在某个**空白**的工作区外会话，首条消息卡片不会恢复（发过消息的会话不受影响）；
- 仅面向 Web / Desktop 的 Web 前端（`dsh.client.platform: web`）。

## 卸载

```text
plugin_manager({ action: "remove_bundle", target: "dsh-outside-workspace" })
```

## 仓库结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：空 `apply`，仅让 bundle 行可加载（能力全在浏览器半）。 |
| `client.js` | 浏览器半：hero 入口按钮 + 首条消息 composer 接管 + 会话创建/跳转。 |
| `cordis.patch.yml` | bundle patch，插入 `outside-workspace` 行。 |
| `locale/*.json` | 插件管理页显示用的标题/描述。 |
| `icon.svg` | 插件图标。 |

## License

MIT
