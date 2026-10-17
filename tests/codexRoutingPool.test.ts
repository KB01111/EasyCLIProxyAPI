import { describe, expect, test } from 'bun:test';
import {
  applyPoolPlan, applyStepToRecord, emptyPoolRecord, loadPoolRecord, planPoolMode, savePoolRecord, POOL_STORAGE_KEY,
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
