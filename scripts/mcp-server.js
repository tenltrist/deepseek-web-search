#!/usr/bin/env node
/**
 * Web Search MCP Server — DuckDuckGo backend for DeepSeek API users
 *
 * Provides a `web_search` tool for Claude Code users on DeepSeek API,
 * where the native WebSearch tool returns "400 deepseek-reasoner does not
 * support this tool_choice".
 *
 * Backend: DuckDuckGo HTML search (free, no API key)
 * Protocol: MCP over stdio via @modelcontextprotocol/sdk
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as cheerio from 'cheerio';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Rate limiter — 1 request/second to avoid DDG throttling
// ---------------------------------------------------------------------------

let lastRequest = 0;
const MIN_INTERVAL = 1000;

async function waitForRateLimit() {
  const elapsed = Date.now() - lastRequest;
  if (elapsed < MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL - elapsed));
  }
  lastRequest = Date.now();
}

// ---------------------------------------------------------------------------
// DDG redirect URL decoder
// ---------------------------------------------------------------------------

function cleanDuckDuckGoUrl(rawUrl) {
  let url = rawUrl.replace(/&amp;/g, '&');

  // Decode DDG redirect URLs: //duckduckgo.com/l/?uddg=<encoded-real-url>
  if (url.includes('duckduckgo.com/l/')) {
    try {
      const qs = url.includes('?') ? url.split('?')[1] : '';
      const params = new URLSearchParams(qs);
      const real = params.get('uddg');
      if (real) return decodeURIComponent(real);
    } catch {}
  }

  if (url.startsWith('//')) return 'https:' + url;
  return url;
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML search — parsed with cheerio
// ---------------------------------------------------------------------------

async function searchDuckDuckGo(query, maxResults = 10) {
  await waitForRateLimit();

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10_000);

  try {
    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) throw new Error(`DuckDuckGo returned ${resp.status}`);

    const html = await resp.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result').each((i, el) => {
      if (results.length >= maxResults) return false;

      const $title = $(el).find('.result__title a');
      const title = $title.text().trim();
      const rawUrl = $title.attr('href') || '';
      const snippet = $(el).find('.result__snippet').text().trim();

      if (title && rawUrl) {
        results.push({
          title,
          url: cleanDuckDuckGoUrl(rawUrl),
          snippet,
        });
      }
    });

    // Detect parsing failure
    if (results.length === 0 && html.length > 500) {
      const sample = html.substring(0, 300).replace(/\n/g, ' ');
      throw new Error(
        `DuckDuckGo HTML parsing returned 0 results. DDG may have changed their markup. ` +
        `HTML sample: ${sample}...`
      );
    }

    return results;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      throw new Error('Search timed out after 10 seconds');
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'web-search',
  version: '1.1.0',
});

server.tool(
  'web_search',
  'Search the web using DuckDuckGo. Returns title, URL, and snippet for each result. Use this to find current information, documentation, news, or any web content.',
  {
    query: z.string().describe('The search query'),
    max_results: z
      .number()
      .min(1)
      .max(20)
      .default(10)
      .describe('Maximum results (default 10, max 20)'),
  },
  async ({ query, max_results }) => {
    try {
      const results = await searchDuckDuckGo(query, max_results);

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No results found for: ${query}` }],
        };
      }

      const text = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   ${r.snippet}`,
        )
        .join('\n\n');

      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Search error: ${e.message}` }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
