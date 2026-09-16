import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const title = source.match(/<title\b[^>]*>[\s\S]*?<\/title>/i)?.[0] ?? '<title>Holdfast</title>';
const styles = [...source.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]);
const body = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]?.trim();

if (!body) throw new Error('index.html has no body content');
await mkdir(new URL('./artifact/', import.meta.url), { recursive: true });
await writeFile(new URL('./artifact/index.html', import.meta.url),
  `${title}\n${styles.join('\n')}\n${body}\n`, 'utf8');
