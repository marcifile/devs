// Loads .env for scripts run outside `npm start`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(file)) for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim(); }
