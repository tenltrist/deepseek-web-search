# DeepSeek Web Search MCP

让 DeepSeek API 用户也能在 Claude Code 中使用 `web_search`。

## 问题

使用 DeepSeek API 作为 Claude Code 后端时，原生的 WebSearch 工具会报错：

```
API Error: 400 deepseek-reasoner does not support this tool_choice
```

原因是 DeepSeek 的 Anthropic 兼容接口不支持 `web_search` 这个 server-side tool。

## 解决方案

这个插件通过 DuckDuckGo（免费，无需 API key）提供独立的 `web_search` MCP 工具，完全绕过 DeepSeek 的限制。

## 安装

### 方式一：通过 GitHub 安装（推荐）

在 Claude Code 中输入：

```
/plugin install tenltrist/deepseek-web-search
```

### 方式二：手动安装

1. 克隆仓库：
```bash
git clone https://github.com/tenltrist/deepseek-web-search.git ~/deepseek-web-search
cd ~/deepseek-web-search && npm install
```

2. 在 `~/.claude/.mcp.json` 中添加：
```json
{
  "mcpServers": {
    "web-search": {
      "command": "node",
      "args": ["/Users/你的用户名/deepseek-web-search/scripts/mcp-server.js"]
    }
  }
}
```

3. 在 `~/.claude/settings.json` 的 `enabledMcpjsonServers` 中添加 `"web-search"`

4. 重启 Claude Code

## 工作原理

```
Claude Code → MCP SDK (stdio) → mcp-server.js → DuckDuckGo HTML → 搜索结果
```

- 通过 DuckDuckGo HTML 搜索（免费，无需 API Key）
- 基于 `@modelcontextprotocol/sdk` 标准 MCP 协议
- `cheerio` 解析 HTML，稳定可靠
- 内置速率限制 & 超时保护
- 自动解码 DDG 跳转链接，返回真实 URL

## 要求

- Node.js >= 18
- `npm install`（安装 `@modelcontextprotocol/sdk`、`cheerio`、`zod`）

## 功能

| 功能 | 原生 WebSearch | 本插件 |
|------|:---:|:---:|
| 网页搜索 | ✅ | ✅ |
| 中文搜索 | ✅ | ✅ |
| 真实 URL | ✅ | ✅ |
| 超时保护 | ❌ | ✅ |
| 速率限制 | ❌ | ✅ |
| 需要 API Key | ❌ | ❌ |
| DeepSeek 兼容 | ❌ | ✅ |

## License

MIT

---

# DeepSeek Web Search MCP (English)

Enables `web_search` in Claude Code for DeepSeek API users.

## Problem

When using DeepSeek API as Claude Code's backend, the native WebSearch tool fails:

```
API Error: 400 deepseek-reasoner does not support this tool_choice
```

DeepSeek's Anthropic-compatible endpoint doesn't support the `web_search` server-side tool.

## Solution

This plugin provides a standalone `web_search` MCP tool powered by DuckDuckGo (free, no API key required), bypassing DeepSeek's limitation entirely.

## Install

### Option 1: Via GitHub (recommended)

In Claude Code:

```
/plugin install tenltrist/deepseek-web-search
```

### Option 2: Manual

1. Clone and configure as shown in the Chinese section above.
2. Restart Claude Code.

## How It Works

```
Claude Code → MCP SDK (stdio) → mcp-server.js → DuckDuckGo HTML → Results
```

- DuckDuckGo HTML search (free, no API key)
- Built on `@modelcontextprotocol/sdk` standard MCP protocol
- `cheerio` HTML parsing for reliability
- Built-in rate limiting & timeout protection
- Auto-decodes DDG redirect links, returning real URLs

## Requirements

- Node.js >= 18
- `npm install` (installs `@modelcontextprotocol/sdk`, `cheerio`, `zod`)

## License

MIT
