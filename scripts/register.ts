// Global command registration — bulk-overwrites the app's commands with
// src/commands/definitions.ts.
//   npm run register:dev   (reads .dev.vars, local development app)
//   npm run register:prod  (CI only: reads DISCORD_APP_ID / DISCORD_BOT_TOKEN
//                           from the environment, i.e. GitHub Actions secrets)

import { readFileSync } from 'node:fs';
import { commandDefinitions } from '../src/commands/definitions';

function parseVarsFile(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return vars;
}

const varsFlag = process.argv.indexOf('--vars');
const varsPath = varsFlag !== -1 ? process.argv[varsFlag + 1] : undefined;
const vars: Record<string, string | undefined> = varsPath ? parseVarsFile(varsPath) : process.env;
const appId = vars.DISCORD_APP_ID;
const token = vars.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error(
    varsPath
      ? `${varsPath} must define DISCORD_APP_ID and DISCORD_BOT_TOKEN`
      : 'Set DISCORD_APP_ID and DISCORD_BOT_TOKEN in the environment, or pass --vars <file>',
  );
  process.exit(1);
}

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT',
  headers: {
    authorization: `Bot ${token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(commandDefinitions),
});

if (!res.ok) {
  console.error(`Registration failed: ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}
const registered = (await res.json()) as { name: string }[];
console.log(`Registered ${registered.length} global commands for app ${appId}:`);
for (const cmd of registered) console.log(`  /${cmd.name}`);
console.log('Reload your Discord client (Ctrl/Cmd-R) if they don’t appear right away.');
