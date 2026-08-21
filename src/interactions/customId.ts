// custom_id is the routing contract for every component click and modal
// submit. It carries only routing + small immutable references; anything
// bulky or mutable lives in pending_actions, addressed by an unguessable
// token. All ids are far below Discord's 100-char cap (guarded anyway).

export type ParsedCustomId =
  | { op: 'modAdd'; retryToken: string | null }
  | { op: 'modEdit'; expenseId: number; baseRevision: number; retryToken: string | null }
  | { op: 'pending'; token: string; action: 'go' | 'm2' | 'x' | 'rt' }
  | { op: 'delete'; expenseId: number; confirm: boolean }
  | { op: 'settle'; expenseId: number; confirm: boolean }
  | { op: 'history'; page: number; withUser: string | null }
  | { op: 'pick'; token: string; action: PickAction }
  | { op: 'roster' };

export type PickAction = 'sel' | 'equal' | 'exact' | 'percent' | 'shares' | 'x';
const PICK_ACTIONS: PickAction[] = ['sel', 'equal', 'exact', 'percent', 'shares', 'x'];

function guard(id: string): string {
  if (id.length > 100) throw new Error(`custom_id too long: ${id}`);
  return id;
}

export const customIds = {
  // The optional token ties a modal reopened from an [Edit & retry] button back
  // to its retry draft, so a successful submit can consume the draft.
  modAdd: (retryToken?: string): string => guard(retryToken ? `mod:add:${retryToken}` : 'mod:add'),
  modEdit: (expenseId: number, baseRevision: number, retryToken?: string): string =>
    guard(`mod:edit:${expenseId}:${baseRevision}${retryToken ? `:${retryToken}` : ''}`),
  pending: (token: string, action: 'go' | 'm2' | 'x' | 'rt'): string =>
    guard(`pnd:${token}:${action}`),
  del: (expenseId: number, confirm: boolean): string => guard(`del:${expenseId}:${confirm ? 'y' : 'n'}`),
  settle: (expenseId: number, confirm: boolean): string => guard(`stl:${expenseId}:${confirm ? 'y' : 'n'}`),
  history: (page: number, withUser: string | null): string =>
    guard(`hst:${page}:${withUser ?? '-'}`),
  pick: (token: string, action: PickAction): string => guard(`pk:${token}:${action}`),
  roster: (): string => 'ro:set',
};

export function parseCustomId(id: string): ParsedCustomId | null {
  const parts = id.split(':');
  switch (parts[0]) {
    case 'mod':
      if (parts[1] === 'add' && (parts.length === 2 || parts.length === 3)) {
        return { op: 'modAdd', retryToken: parts[2] ?? null };
      }
      if (parts[1] === 'edit' && (parts.length === 4 || parts.length === 5)) {
        const expenseId = Number(parts[2]);
        const baseRevision = Number(parts[3]);
        if (Number.isInteger(expenseId) && Number.isInteger(baseRevision)) {
          return { op: 'modEdit', expenseId, baseRevision, retryToken: parts[4] ?? null };
        }
      }
      return null;
    case 'pnd': {
      const [, token, action] = parts;
      if (parts.length === 3 && token && (action === 'go' || action === 'm2' || action === 'x' || action === 'rt')) {
        return { op: 'pending', token, action };
      }
      return null;
    }
    case 'del':
    case 'stl': {
      const expenseId = Number(parts[1]);
      const flag = parts[2];
      if (parts.length === 3 && Number.isInteger(expenseId) && (flag === 'y' || flag === 'n')) {
        return parts[0] === 'del'
          ? { op: 'delete', expenseId, confirm: flag === 'y' }
          : { op: 'settle', expenseId, confirm: flag === 'y' };
      }
      return null;
    }
    case 'pk': {
      const [, token, action] = parts;
      if (parts.length === 3 && token && PICK_ACTIONS.includes(action as PickAction)) {
        return { op: 'pick', token, action: action as PickAction };
      }
      return null;
    }
    case 'ro':
      return parts.length === 2 && parts[1] === 'set' ? { op: 'roster' } : null;
    case 'hst': {
      const page = Number(parts[1]);
      const withUser = parts[2];
      if (parts.length === 3 && Number.isInteger(page) && page >= 1 && withUser) {
        return { op: 'history', page, withUser: withUser === '-' ? null : withUser };
      }
      return null;
    }
    default:
      return null;
  }
}
