import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';

// ---- Ed25519 signing (the real verification path, no mocks) ----

interface TestKeys {
  publicKeyHex: string;
  privateKey: CryptoKey;
}

let keys: TestKeys | null = null;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function testKeys(): Promise<TestKeys> {
  if (!keys) {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    keys = { publicKeyHex: toHex(raw), privateKey: pair.privateKey };
  }
  return keys;
}

export async function signedRequest(body: string, tamper = false): Promise<Request> {
  const { privateKey } = await testKeys();
  const timestamp = '1755400000';
  const data = new TextEncoder().encode(timestamp + body);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data));
  return new Request('https://bot.example/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': toHex(signature),
      'x-signature-timestamp': tamper ? '1755400001' : timestamp,
    },
    body,
  });
}

export interface SentInteraction {
  status: number;
  body: any;
  /** Resolves once waitUntil work (follow-up posts) has finished. */
  settled: Promise<unknown>;
}

export async function send(interaction: unknown): Promise<SentInteraction> {
  const { publicKeyHex } = await testKeys();
  const req = await signedRequest(JSON.stringify(interaction));
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, { ...env, DISCORD_PUBLIC_KEY: publicKeyHex }, ctx);
  const text = await res.text();
  // Drain waitUntil work (follow-ups, hints) before returning so nothing
  // touches the database after the next test's reset().
  await waitOnExecutionContext(ctx);
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    settled: Promise.resolve(),
  };
}

// ---- Interaction payload builders ----

let nextId = 1000;

export const CHANNEL = '900000000000000001';
export const ALICE = { id: '100000000000000001', username: 'alice' };
export const BOB = { id: '100000000000000002', username: 'bob' };
export const CARA = { id: '100000000000000003', username: 'cara' };

export function resolvedUsers(...users: { id: string; username: string; bot?: boolean }[]) {
  return { users: Object.fromEntries(users.map((u) => [u.id, { ...u, bot: u.bot ?? false }])) };
}

interface Common {
  user?: { id: string; username: string };
  channelId?: string;
  context?: number;
  resolved?: unknown;
  channel?: { type: number; recipients?: { id: string; username: string; bot?: boolean }[] };
}

function base(type: number, common: Common) {
  nextId += 1;
  const channelId = common.channelId ?? CHANNEL;
  return {
    id: String(nextId),
    application_id: 'app123',
    type,
    token: `interaction-token-${nextId}`,
    channel_id: channelId,
    channel: common.channel ? { id: channelId, ...common.channel } : undefined,
    context: common.context ?? 2,
    user: common.user ?? ALICE,
  };
}

export function ping() {
  return { ...base(1, {}), type: 1 };
}

export function slash(
  name: string,
  opts: Common & { sub?: string; options?: { name: string; type: number; value: unknown }[] } = {},
) {
  const options = opts.sub
    ? [{ type: 1, name: opts.sub, options: opts.options ?? [] }]
    : (opts.options ?? []);
  return { ...base(2, opts), data: { name, type: 1, options, resolved: opts.resolved } };
}

export function autocompleteFor(name: string, sub: string, query: string, opts: Common = {}) {
  return {
    ...base(4, opts),
    data: {
      name,
      type: 1,
      options: [{ type: 1, name: sub, options: [{ type: 3, name: 'id', value: query, focused: true }] }],
    },
  };
}

export interface ExpenseFormValues {
  amount?: string;
  desc?: string;
  participants?: string[];
  payer?: string[];
  method?: string;
}

export function expenseModalSubmit(
  customId: string,
  values: ExpenseFormValues,
  opts: Common & { fromMessage?: boolean } = {},
) {
  const components = [
    { type: 18, component: { type: 4, custom_id: 'amount', value: values.amount ?? '' } },
    { type: 18, component: { type: 4, custom_id: 'desc', value: values.desc ?? '' } },
    { type: 18, component: { type: 5, custom_id: 'participants', values: values.participants ?? [] } },
    { type: 18, component: { type: 21, custom_id: 'method', values: [values.method ?? 'equal'] } },
    { type: 18, component: { type: 5, custom_id: 'payer', values: values.payer ?? [] } },
  ];
  const payload = {
    ...base(5, opts),
    data: { custom_id: customId, components, resolved: opts.resolved },
  } as Record<string, unknown>;
  if (opts.fromMessage) payload.message = { id: 'msg1' };
  return payload;
}

export function splitModalSubmit(customId: string, values: string, opts: Common = {}) {
  return {
    ...base(5, opts),
    data: {
      custom_id: customId,
      components: [{ type: 18, component: { type: 4, custom_id: 'values', value: values } }],
    },
    message: { id: 'prompt-msg' },
  };
}

export function perPersonModalSubmit(customId: string, cells: string[], opts: Common = {}) {
  return {
    ...base(5, opts),
    data: {
      custom_id: customId,
      components: cells.map((value, idx) => ({
        type: 18,
        component: { type: 4, custom_id: `v:${idx}`, value },
      })),
    },
    message: { id: 'prompt-msg' },
  };
}

export function click(customId: string, opts: Common = {}) {
  return {
    ...base(3, opts),
    data: { custom_id: customId, component_type: 2 },
    message: { id: 'clicked-msg' },
  };
}

// ---- Response inspection ----

export function customIdsIn(node: unknown): string[] {
  const found: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const obj = n as Record<string, unknown>;
    if (typeof obj.custom_id === 'string') found.push(obj.custom_id);
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(node);
  return found;
}

export function textIn(node: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const obj = n as Record<string, unknown>;
    if (typeof obj.content === 'string') parts.push(obj.content);
    if (typeof obj.label === 'string') parts.push(obj.label);
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(node);
  return parts.join('\n');
}

export const EPHEMERAL = 1 << 6;
