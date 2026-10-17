import {
  isOAuthCredentialFile,
  parseAuthFilePriority,
  setOAuthCredentialFileDisabled,
  type AuthFileRecord,
} from './authFiles';
import { managementApi, readBoolean, readString } from './managementApi';
import { providerForFile } from './quotaService';

// Proxy routing pool presets. They only use existing management-API features
// (a credential's `disabled` flag and `priority`) and remember exactly what they
// changed so "Use all enabled accounts" restores those values and nothing else.
// This is GLOBAL: it affects every client using the local CLIProxyAPI proxy.

export type PoolMode = 'all' | 'only-ab' | 'prefer-a' | 'prefer-b';

export type PoolFile = { name: string; disabled: boolean; priority: number };

/** What this feature changed on one credential, with the values before and after. */
export type PoolChange = {
  prevDisabled?: boolean;
  setDisabled?: boolean;
  prevPriority?: number;
  setPriority?: number;
};

export type PoolRecord = {
  version: 1;
  mode: PoolMode;
  appliedAt: number;
  changes: Record<string, PoolChange>;
};

export type PoolStep = {
  name: string;
  /** Patch to apply; omitted fields are untouched. A step with neither is bookkeeping only. */
  disabled?: boolean;
  priority?: number;
  /** Record entry to store after the step succeeds; null removes the entry. */
  entry: PoolChange | null;
};

export type PoolPlan = {
  mode: PoolMode;
  steps: PoolStep[];
  /** Credentials the mode wanted to change but could not, or deliberately left alone. */
  warnings: { name: string; reason: 'preferred-missing' | 'preferred-disabled' | 'changed-since' }[];
};

export const emptyPoolRecord = (): PoolRecord => ({ version: 1, mode: 'all', appliedAt: 0, changes: {} });

export const POOL_STORAGE_KEY = 'easy-cli-proxy-api.codex-routing-pool.v1';

export function poolFileFrom(file: AuthFileRecord): PoolFile {
  return {
    name: readString(file, 'name'),
    disabled: readBoolean(file, 'disabled'),
    priority: parseAuthFilePriority(file.priority) ?? 0,
  };
}

/**
 * The values each credential had before this feature touched it. A recorded change
 * only counts while the credential still holds the value we set; if the user edited
 * it afterwards we leave their value alone.
 */
function originalState(files: readonly PoolFile[], record: PoolRecord) {
  const original = new Map<string, PoolFile>();
  const releasedByUser = new Set<string>();
  for (const file of files) {
    const change = record.changes[file.name];
    let { disabled, priority } = file;
    if (change) {
      if (change.setDisabled !== undefined && change.prevDisabled !== undefined) {
        if (file.disabled === change.setDisabled) disabled = change.prevDisabled;
        else releasedByUser.add(file.name);
      }
      if (change.setPriority !== undefined && change.prevPriority !== undefined) {
        if (file.priority === change.setPriority) priority = change.prevPriority;
        else releasedByUser.add(file.name);
      }
    }
    original.set(file.name, { name: file.name, disabled, priority });
  }
  return { original, releasedByUser };
}

/**
 * Computes the credential patches for `mode`. `a`/`b` are the credential file names of
 * the two pinned accounts. Existing recorded changes are first restored (guarded), then
 * the new mode is derived from the restored values, so switching modes never stacks edits.
 */
export function planPoolMode(
  mode: PoolMode,
  codexFiles: readonly PoolFile[],
  names: { a: string | null; b: string | null },
  record: PoolRecord,
): PoolPlan {
  const { original, releasedByUser } = originalState(codexFiles, record);
  const warnings: PoolPlan['warnings'] = [];
  const desired = new Map<string, { disabled: boolean; priority: number }>();
  for (const [name, value] of original) desired.set(name, { disabled: value.disabled, priority: value.priority });

  const known = new Set(codexFiles.map((file) => file.name));
  if (mode === 'only-ab') {
    const keep = new Set([names.a, names.b].filter((name): name is string => Boolean(name)));
    for (const name of keep) {
      if (!known.has(name)) warnings.push({ name, reason: 'preferred-missing' });
      else if (original.get(name)?.disabled) warnings.push({ name, reason: 'preferred-disabled' });
    }
    for (const file of codexFiles) {
      if (!keep.has(file.name) && !original.get(file.name)!.disabled) desired.get(file.name)!.disabled = true;
    }
  } else if (mode === 'prefer-a' || mode === 'prefer-b') {
    const preferred = mode === 'prefer-a' ? names.a : names.b;
    if (!preferred || !known.has(preferred)) {
      if (preferred) warnings.push({ name: preferred, reason: 'preferred-missing' });
    } else {
      if (original.get(preferred)!.disabled) warnings.push({ name: preferred, reason: 'preferred-disabled' });
      const others = codexFiles.filter((file) => file.name !== preferred && !original.get(file.name)!.disabled);
      const highest = others.length ? Math.max(...others.map((file) => original.get(file.name)!.priority)) : null;
      const current = original.get(preferred)!.priority;
      if (highest !== null && current <= highest) desired.get(preferred)!.priority = highest + 1;
    }
  }

  const steps: PoolStep[] = [];
  const touched = new Set<string>();
  for (const file of codexFiles) {
    const want = desired.get(file.name)!;
    const before = original.get(file.name)!;
    const recorded = record.changes[file.name];
    const entry: PoolChange = {};
    if (want.disabled !== before.disabled) {
      entry.prevDisabled = before.disabled;
      entry.setDisabled = want.disabled;
    }
    if (want.priority !== before.priority) {
      entry.prevPriority = before.priority;
      entry.setPriority = want.priority;
    }
    const hasEntry = Object.keys(entry).length > 0;
    const patchDisabled = want.disabled !== file.disabled ? want.disabled : undefined;
    const patchPriority = want.priority !== file.priority ? want.priority : undefined;
    if (patchDisabled === undefined && patchPriority === undefined && !hasEntry && !recorded) continue;
    if (patchDisabled === undefined && patchPriority === undefined && hasEntry
      && JSON.stringify(entry) === JSON.stringify(recorded)) continue;
    steps.push({
      name: file.name,
      ...(patchDisabled !== undefined ? { disabled: patchDisabled } : {}),
      ...(patchPriority !== undefined ? { priority: patchPriority } : {}),
      entry: hasEntry ? entry : null,
    });
    touched.add(file.name);
  }
  for (const name of releasedByUser) {
    if (!warnings.some((warning) => warning.name === name)) warnings.push({ name, reason: 'changed-since' });
  }
  // Records for credentials that no longer exist are dropped silently on the next apply.
  for (const name of Object.keys(record.changes)) {
    if (!known.has(name) && !touched.has(name)) steps.push({ name, entry: null });
  }
  return { mode, steps, warnings };
}

/** Record after applying `steps` in order (used for incremental persistence on partial failure). */
export function applyStepToRecord(record: PoolRecord, step: PoolStep, mode: PoolMode, now: number): PoolRecord {
  const changes = { ...record.changes };
  if (step.entry) changes[step.name] = step.entry;
  else delete changes[step.name];
  return { version: 1, mode, appliedAt: now, changes };
}

export function loadPoolRecord(storage: Pick<Storage, 'getItem'> | null = safeStorage()): PoolRecord {
  try {
    const raw = storage?.getItem(POOL_STORAGE_KEY);
    if (!raw) return emptyPoolRecord();
    const parsed = JSON.parse(raw) as Partial<PoolRecord>;
    if (parsed?.version !== 1 || typeof parsed.changes !== 'object' || parsed.changes === null) return emptyPoolRecord();
    const mode: PoolMode = ['all', 'only-ab', 'prefer-a', 'prefer-b'].includes(String(parsed.mode))
      ? parsed.mode as PoolMode : 'all';
    return { version: 1, mode, appliedAt: Number(parsed.appliedAt) || 0, changes: parsed.changes as Record<string, PoolChange> };
  } catch {
    return emptyPoolRecord();
  }
}

export function savePoolRecord(record: PoolRecord, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()) {
  try {
    if (Object.keys(record.changes).length === 0 && record.mode === 'all') storage?.removeItem(POOL_STORAGE_KEY);
    else storage?.setItem(POOL_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the pool still works for this session.
  }
}

function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/**
 * Applies the plan through the existing management API, persisting the record after every
 * successful step so a mid-way failure never loses track of what was changed.
 */
export async function applyPoolPlan(
  plan: PoolPlan,
  files: readonly AuthFileRecord[],
  record: PoolRecord,
  options: { now?: number; persist?: (record: PoolRecord) => void } = {},
): Promise<PoolRecord> {
  const persist = options.persist ?? savePoolRecord;
  const now = options.now ?? Date.now();
  let current = record;
  for (const step of plan.steps) {
    const file = files.find((candidate) => readString(candidate, 'name') === step.name);
    if (step.disabled !== undefined || step.priority !== undefined) {
      if (!file) throw new Error(step.name);
      if (step.disabled !== undefined) await setOAuthCredentialFileDisabled(file, step.disabled);
      if (step.priority !== undefined) await managementApi.patch('/credentials/fields', { name: step.name, priority: step.priority });
    }
    current = applyStepToRecord(current, step, plan.mode, now);
    persist(current);
  }
  if (plan.steps.length === 0) {
    current = { ...current, mode: plan.mode, appliedAt: now };
    persist(current);
  }
  return current;
}

/** Codex OAuth credential files known to the core: the only credentials the pool may touch. */
export const codexPoolFiles = (files: readonly AuthFileRecord[]): AuthFileRecord[] =>
  files.filter((file) => isOAuthCredentialFile(file) && providerForFile(file) === 'codex');
