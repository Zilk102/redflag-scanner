import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const clientRoot = process.cwd();
const distDir = path.join(clientRoot, 'dist');
const indexHtmlPath = path.join(distDir, 'index.html');

const indexHtml = await fs.readFile(indexHtmlPath, 'utf-8');

const entryUrl = pathToFileURL(path.join(distDir, 'server', 'entry-server.js')).href;
const { render } = await import(entryUrl);

const rendered = typeof render === 'function' ? render() : null;
const appHtml = rendered && typeof rendered === 'object' && 'appHtml' in rendered ? String(rendered.appHtml) : '';
const headHtml = rendered && typeof rendered === 'object' && 'headHtml' in rendered ? String(rendered.headHtml) : '';

const marker = '<div id="root"></div>';
if (!indexHtml.includes(marker)) {
  throw new Error('prerender_failed: root marker not found');
}

const helmetMarker = '<meta name="x-prerender-head" content="" />';
if (!indexHtml.includes(helmetMarker)) {
  throw new Error('prerender_failed: helmet marker not found');
}

const withHead = indexHtml.replace(helmetMarker, headHtml);
const normalized = headHtml.includes('<title') ? withHead.replace(/<title>[\s\S]*?<\/title>/i, '') : withHead;
const outHtml = normalized.replace(marker, `<div id="root">${appHtml}</div>`);
await fs.writeFile(indexHtmlPath, outHtml);

await fs.rm(path.join(distDir, 'server'), { recursive: true, force: true });
