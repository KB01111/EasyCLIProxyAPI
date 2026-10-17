import { describe, expect, test } from 'bun:test';
import {
  applyPoolPlan, applyStepToRecord, type PoolApi, emptyPoolRecord, loadPoolRecord, planPoolMode, savePoolRecord, POOL_STORAGE_KEY,
  type PoolFile, type PoolRecord,
} from '../src/services/codexRoutingPool';

const files = (): PoolFile[] => [
  { name: 'a.json', disabled: false, priority: 0 },
  { name: 'b.json', disabled: false, priority: 1 },
  { name: 'c.json', disabled: false, priority: 5 },
  { name: 'user-off.json', disabled: true, priority: 0 },
];
const names = { a: 'a.json', b: 'b.json' };

const run = (plan: ReturnType<typeof planPoolMode>, current: PoolFile[], record: PoolRecord): { files: PoolFile[]; record: PoolRecord } => {
  let next = record;
  const updated = current.map((file) => ({ ...file }));
  for (const step of plan.steps) {
    const file = updated.find((candidate) => candidate.name === step.name);
    if (file && step.disabled !== undefined) file.disabled = step.disabled;
    if (file && step.priority !== undefined) file.priority = step.priority;
    next = applyStepToRecord(next, step, plan.mode, 1);
  }
  return { files: updated, record: next };
};

describe('planPoolMode', () => {
  test('only A and B disables the others but never touches credentials the user already disabled', () => {
    const plan = planPoolMode('only-ab', files(), names, emptyPoolRecord());
    expect(plan.steps.map((step) => [step.name, step.disabled])).toEqual([['c.json', true]]);
    expect(plan.steps[0].entry).toEqual({ prevDisabled: false, setDisabled: true });
  });

  test('prefer raises only the preferred credential above every other enabled one', () => {
    const plan = planPoolMode('prefer-a', files(), names, emptyPoolRecord());
    expect(plan.steps).toEqual([{ name: 'a.json', priority: 6, entry: { prevPriority: 0, setPriority: 6 } }]);
    // Already highest: nothing to do.
    const high = files().map((file) => file.name === 'b.json' ? { ...file, priority: 9 } : file);
    expect(planPoolMode('prefer-b', high, names, emptyPoolRecord()).steps).toEqual([]);
  });

  test('use all restores exactly what this feature changed and leaves everything else', () => {
    const first = run(planPoolMode('only-ab', files(), names, emptyPoolRecord()), files(), emptyPoolRecord());
    const second = run(planPoolMode('prefer-a', first.files, names, first.record), first.files, first.record);
    // Switching modes restores c.json and then raises a.json: edits never stack.
    expect(second.files.find((file) => file.name === 'c.json')?.disabled).toBe(false);
    expect(second.files.find((file) => file.name === 'a.json')?.priority).toBe(6);
    const restored = run(planPoolMode('all', second.files, names, second.record), second.files, second.record);
    expect(restored.files).toEqual(files());
    expect(restored.record.changes).toEqual({});
  });

  test('a credential the user changed afterwards is left alone', () => {
    const first = run(planPoolMode('only-ab', files(), names, emptyPoolRecord()), files(), emptyPoolRecord());
    const edited = first.files.map((file) => file.name === 'c.json' ? { ...file, disabled: false, priority: 7 } : file);
    const plan = planPoolMode('all', edited, names, first.record);
    expect(plan.steps.filter((step) => step.disabled !== undefined || step.priority !== undefined)).toEqual([]);
    expect(plan.warnings).toEqual([{ name: 'c.json', reason: 'changed-since' }]);
    expect(run(plan, edited, first.record).record.changes).toEqual({});
  });

  test('re-applying the same mode is a no-op and missing or disabled preferred credentials only warn', () => {
    const first = run(planPoolMode('only-ab', files(), names, emptyPoolRecord()), files(), emptyPoolRecord());
    expect(planPoolMode('only-ab', first.files, names, first.record).steps).toEqual([]);
    expect(planPoolMode('prefer-a', files(), { a: 'gone.json', b: null }, emptyPoolRecord()).warnings).toEqual([{ name: 'gone.json', reason: 'preferred-missing' }]);
    const disabledA = files().map((file) => file.name === 'a.json' ? { ...file, disabled: true } : file);
    const plan = planPoolMode('only-ab', disabledA, names, emptyPoolRecord());
    expect(plan.warnings).toContainEqual({ name: 'a.json', reason: 'preferred-disabled' });
    expect(plan.steps.some((step) => step.name === 'a.json')).toBe(false);
  });
});

describe('pool edge cases', () => {
  test('re-applying only-ab keeps a credential the user re-enabled after we disabled it', () => {
    const first = run(planPoolMode('only-ab', files(), names, emptyPoolRecord()), files(), emptyPoolRecord());
    const reEnabled = first.files.map((file) => file.name === 'c.json' ? { ...file, disabled: false } : file);
    const plan = planPoolMode('only-ab', reEnabled, names, first.record);
    expect(plan.steps.filter((step) => step.disabled !== undefined)).toEqual([]);
    expect(plan.warnings).toContainEqual({ name: 'c.json', reason: 'changed-since' });
    const applied = run(plan, reEnabled, first.record);
    expect(applied.files.find((file) => file.name === 'c.json')?.disabled).toBe(false);
    expect(applied.record.changes['c.json']).toBeUndefined();
    // The next explicit apply starts from the user's value and may disable it again.
    expect(planPoolMode('only-ab', applied.files, names, applied.record).steps.map((step) => step.name)).toEqual(['c.json']);
  });

  test('prefer keeps a priority the user changed after we raised it', () => {
    const first = run(planPoolMode('prefer-a', files(), names, emptyPoolRecord()), files(), emptyPoolRecord());
    const edited = first.files.map((file) => file.name === 'a.json' ? { ...file, priority: 1 } : file);
    const plan = planPoolMode('prefer-a', edited, names, first.record);
    expect(plan.steps.filter((step) => step.priority !== undefined)).toEqual([]);
  });

  test('a failing priority patch after a successful disable still leaves the disable restorable', async () => {
    const start: PoolFile[] = [
      { name: 'a.json', disabled: false, priority: 0 },
      { name: 'x.json', disabled: false, priority: 3 },
    ];
    // Hand-built step that changes both fields of one credential.
    const plan = { mode: 'only-ab' as const, warnings: [], steps: [{
      name: 'x.json', disabled: true, priority: 9,
      entry: { prevDisabled: false, setDisabled: true, prevPriority: 3, setPriority: 9 },
    }] };
    const live = new Map(start.map((file) => [file.name, { ...file }]));
    const api: PoolApi = {
      setDisabled: async (file, disabled) => { live.get(String(file.name))!.disabled = disabled; },
      setPriority: async () => { throw new Error('management API unavailable'); },
    };
    const persisted: PoolRecord[] = [];
    const file = { name: 'x.json', source: 'file', type: 'codex', provider: 'codex' };
    await expect(applyPoolPlan(plan, [file], emptyPoolRecord(), { api, persist: (record) => persisted.push(record) })).rejects.toThrow('unavailable');
    const saved = persisted.at(-1)!;
    expect(saved.changes['x.json']).toEqual({ prevDisabled: false, setDisabled: true });
    // A later "use all enabled accounts" plan re-enables it, and only it.
    const restore = planPoolMode('all', [...live.values()], names, saved);
    expect(restore.steps).toEqual([{ name: 'x.json', disabled: false, entry: null }]);
  });
});

describe('pool persistence', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key), data };
  };

  test('round-trips and tolerates corrupt or unavailable storage', () => {
    const storage = memory();
    const record = applyStepToRecord(emptyPoolRecord(), { name: 'c.json', disabled: true, entry: { prevDisabled: false, setDisabled: true } }, 'only-ab', 5);
    savePoolRecord(record, storage);
    expect(loadPoolRecord(storage)).toEqual(record);
    storage.setItem(POOL_STORAGE_KEY, '{nope');
    expect(loadPoolRecord(storage)).toEqual(emptyPoolRecord());
    expect(loadPoolRecord({ getItem: () => { throw new Error('blocked'); } })).toEqual(emptyPoolRecord());
    expect(() => savePoolRecord(record, { setItem: () => { throw new Error('quota'); }, removeItem: () => undefined })).not.toThrow();
    savePoolRecord(emptyPoolRecord(), storage);
    expect(storage.data.has(POOL_STORAGE_KEY)).toBe(false);
  });

  test('stops at the first failing step but keeps the record of what already changed', async () => {
    const plan = planPoolMode('only-ab', files().concat([{ name: 'd.json', disabled: false, priority: 0 }]), names, emptyPoolRecord());
    const persisted: PoolRecord[] = [];
    // Neither credential is a real OAuth file entry, so the first patch is rejected before any request.
    await expect(applyPoolPlan(plan, [{ name: 'c.json' }], emptyPoolRecord(), { persist: (record) => persisted.push(record) })).rejects.toBeTruthy();
    expect(persisted).toEqual([]);
  });
});
