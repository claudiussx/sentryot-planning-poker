// npm run bump: new release version on every file URL, and a Content-Security-Policy
// whose script hash matches the inline importmap (the only inline script).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = new URL('../index.html', import.meta.url);
let html = readFileSync(file, 'utf8');

const version = Number(html.match(/\?v=(\d+)/)[1]) + 1;
html = html.replace(/\?v=\d+/g, `?v=${version}`);

const importmap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
const hash = createHash('sha256').update(importmap, 'utf8').digest('base64');

const csp = [
  "default-src 'none'",
  `script-src 'self' 'sha256-${hash}'`,
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  'connect-src wss://broker.hivemq.com:8884 wss://broker.emqx.io:8084 wss://test.mosquitto.org:8081',
  'worker-src blob:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

html = html.replace(/(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/, `$1${csp}$2`);
writeFileSync(file, html);
console.log('version', version);
