import { describe, expect, it } from 'vitest';
import { customIds, parseCustomId } from '../src/interactions/customId';

describe('customId codec', () => {
  it('round-trips every op', () => {
    expect(parseCustomId(customIds.modAdd())).toEqual({ op: 'modAdd', retryToken: null });
    expect(parseCustomId(customIds.modAdd('abcdefghij'))).toEqual({ op: 'modAdd', retryToken: 'abcdefghij' });
    expect(parseCustomId(customIds.modEdit(42, 3))).toEqual({
      op: 'modEdit',
      expenseId: 42,
      baseRevision: 3,
      retryToken: null,
    });
    expect(parseCustomId(customIds.modEdit(42, 3, 'abcdefghij'))).toEqual({
      op: 'modEdit',
      expenseId: 42,
      baseRevision: 3,
      retryToken: 'abcdefghij',
    });
    expect(parseCustomId(customIds.pending('abcdefghij', 'go'))).toEqual({
      op: 'pending',
      token: 'abcdefghij',
      action: 'go',
    });
    expect(parseCustomId(customIds.pending('abcdefghij', 'm2'))).toEqual({
      op: 'pending',
      token: 'abcdefghij',
      action: 'm2',
    });
    expect(parseCustomId(customIds.del(7, true))).toEqual({ op: 'delete', expenseId: 7, confirm: true });
    expect(parseCustomId(customIds.settle(9, false))).toEqual({ op: 'settle', expenseId: 9, confirm: false });
    expect(parseCustomId(customIds.history(3, null))).toEqual({ op: 'history', page: 3, withUser: null });
    expect(parseCustomId(customIds.history(1, '100000000000000001'))).toEqual({
      op: 'history',
      page: 1,
      withUser: '100000000000000001',
    });
  });

  it('rejects garbage', () => {
    for (const bad of ['', 'nope', 'mod:', 'mod:edit:x:y', 'pnd:tok', 'pnd:tok:zz', 'del:1:maybe', 'hst:0:-', 'hst:abc:-']) {
      expect(parseCustomId(bad)).toBeNull();
    }
  });

  it('stays far under the 100-char cap with worst-case ids', () => {
    expect(customIds.history(9999, '9'.repeat(19)).length).toBeLessThan(50);
    expect(customIds.modEdit(2 ** 31, 10 ** 6).length).toBeLessThan(30);
  });
});
