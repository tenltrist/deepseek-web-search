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
// HTTP helper
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return resp;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('Request timed out after 10 seconds');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML search (primary)
// ---------------------------------------------------------------------------

async function searchDDGhtml(query, maxResults) {
  const resp = await fetchWithTimeout('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ q: query }).toString(),
  });

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
      results.push({ title, url: cleanDuckDuckGoUrl(rawUrl), snippet });
    }
  });

  if (results.length === 0 && html.length > 500) {
    const sample = html.substring(0, 300).replace(/\n/g, ' ');
    throw new Error(
      `DDG HTML parsing returned 0 results. Markup may have changed. Sample: ${sample}...`
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// DuckDuckGo Lite search (fallback — simpler, text-only page)
// ---------------------------------------------------------------------------

async function searchDDGlite(query, maxResults) {
  const resp = await fetchWithTimeout('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: new URLSearchParams({ q: query }).toString(),
  });

  if (!resp.ok) throw new Error(`DDG Lite returned ${resp.status}`);

  const html = await resp.text();
  const $ = cheerio.load(html);
  const results = [];

  // DDG Lite: results are in <tr> rows with <a> title + <td> snippet
  $('tr').each((i, el) => {
    if (results.length >= maxResults) return false;

    const $link = $(el).find('a.result-link');
    if (!$link.length) return;

    const title = $link.text().trim();
    const rawUrl = $link.attr('href') || '';
    // Snippet is in the last <td> of the row
    const $tds = $(el).find('td');
    const snippet = $tds.last().text().trim();

    if (title && rawUrl) {
      results.push({ title, url: cleanDuckDuckGoUrl(rawUrl), snippet });
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// Combined search — HTML first, Lite fallback
// ---------------------------------------------------------------------------

async function searchDuckDuckGo(query, maxResults = 10) {
  await waitForRateLimit();

  try {
    return await searchDDGhtml(query, maxResults);
  } catch (e) {
    process.stderr.write(`[web-search] DDG HTML failed: ${e.message}, trying Lite...\n`);
    try {
      await waitForRateLimit();
      return await searchDDGlite(query, maxResults);
    } catch (e2) {
      process.stderr.write(`[web-search] DDG Lite also failed: ${e2.message}\n`);
      throw new Error(`All search backends failed: ${e2.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Page content extraction
// ---------------------------------------------------------------------------

function extractContent(html, url) {
  const $ = cheerio.load(html);

  // Remove non-content elements
  $('script, style, noscript, iframe, svg, nav, footer, header, aside, ' +
    '.sidebar, .nav, .footer, .header, .menu, .ad, .advertisement, ' +
    '[role="navigation"], [role="banner"], [role="contentinfo"]').remove();

  // Try semantic content containers first
  const contentSelectors = [
    'article', 'main', '[role="main"]', '.post-content', '.article-content',
    '.entry-content', '.content', '#content', '.post', '.article',
  ];

  let $content = null;
  for (const sel of contentSelectors) {
    $content = $(sel).first();
    if ($content.length && $content.text().trim().length > 100) break;
    $content = null;
  }

  // Fall back to body
  if (!$content) $content = $('body');

  // Extract text and normalize whitespace
  let text = $content.text();
  text = text
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'web-search',
  version: '1.2.0',
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

server.tool(
  'fetch_page',
  'Fetch and extract the main text content from a web page URL. Strips navigation, scripts, styles, and ads — returns clean readable text. Use this to read the full content of any URL found via web_search.',
  {
    url: z.string().url().describe('The URL of the web page to fetch'),
    max_length: z
      .number()
      .min(0)
      .default(10000)
      .describe('Max characters to return (0 = no limit, default 10000)'),
  },
  async ({ url, max_length }) => {
    try {
      const resp = await fetchWithTimeout(url, {
        headers: { 'User-Agent': UA },
      });

      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

      const contentType = resp.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        throw new Error(`Not an HTML page (content-type: ${contentType})`);
      }

      const html = await resp.text();
      let text = extractContent(html, url);

      const len = text.length;
      if (max_length > 0 && len > max_length) {
        text = text.substring(0, max_length) + `\n\n[Truncated at ${max_length} chars / ${len} total]`;
      }

      return {
        content: [{ type: 'text', text: text || '(No content extracted)' }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Fetch error: ${e.message}` }],
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
