import { SEED_ROWS } from './seed'
import { MODULE_BY_KEY, MODULES, UNCATEGORIZED_MODULE } from './modules'
import { ensureTodaySnapshot, summarize } from './stats'
import type { EntryRow, StatSnapshot, StoredState } from './types'

// 本地持久化：业务数据、统计口径、历史快照放在同一个信封里一次落库。
// 刷新、关掉再打开都还在；落库失败时内存缓存一起回滚，不会出现半套数字。
const STORAGE_KEY = 'airport-ground-handling:entries'
const STORAGE_FORMAT = 2
const UNCATEGORIZED_KEY = UNCATEGORIZED_MODULE.key

export type CommitResult =
  | { ok: true; state: StoredState }
  | { ok: false; message: string }

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function todayKey(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function normalizeRow(raw: unknown, fallbackId: number): EntryRow | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const item = raw as Record<string, unknown>
  const id = Number(item.id)
  if (!Number.isFinite(id)) {
    return null
  }
  return {
    ...(item as EntryRow),
    id,
    status: String(item.status ?? ''),
    pending: item.pending === true,
    abnormal: item.abnormal === true,
  }
}

type MigratedState = {
  entries: Record<string, EntryRow[]>
  snapshots: StatSnapshot[]
  // 信封沿用时保留原版本；旧格式迁移或首次建账才从 0 起步。
  version: number | null
}

// 旧格式（裸的「模块->数组」）迁移到信封：注册桶里的记录补打模块归属，
// 对应不上已注册模块的存量记录统一回填到「未分类」，保留原结论数据不丢。
// 已是信封格式的直接沿用，版本与历史快照原样保留，不被本次加载重建。
function migrateLegacy(raw: string): MigratedState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const envelope = parsed as Partial<StoredState>
  if (envelope.format === STORAGE_FORMAT && envelope.entries) {
    return {
      entries: clone(envelope.entries),
      snapshots: Array.isArray(envelope.snapshots) ? clone(envelope.snapshots) : [],
      version: typeof envelope.version === 'number' ? envelope.version : 0,
    }
  }
  const legacy = parsed as Record<string, unknown>
  const registered = new Set(MODULES.map((meta) => meta.key))
  const entries: Record<string, EntryRow[]> = {}
  const loose: EntryRow[] = []
  for (const [key, value] of Object.entries(legacy)) {
    if (!Array.isArray(value)) {
      continue
    }
    const ownerName = MODULE_BY_KEY.get(key)?.name ?? key
    value.forEach((rawRow, index) => {
      const row = normalizeRow(rawRow, index + 1)
      if (!row) {
        return
      }
      if (registered.has(key)) {
        row.模块归属 = ownerName
        ;(entries[key] ??= []).push(row)
      } else {
        // 缺模块归属：记住它原来挂在哪个桶，回填到未分类。
        row.模块归属 = UNCATEGORIZED_MODULE.name
        row.原属模块 = ownerName
        loose.push(row)
      }
    })
  }
  // 多个游离桶可能产生重复 id，未分类内顺序去重。
  const usedIds = new Set<number>()
  let nextId = loose.reduce((max, row) => Math.max(max, Number(row.id)), 0)
  const uncategorized = loose.map((row) => {
    if (usedIds.has(row.id)) {
      nextId += 1
      return { ...row, id: nextId }
    }
    usedIds.add(row.id)
    return row
  })
  if (uncategorized.length > 0) {
    entries[UNCATEGORIZED_KEY] = uncategorized
  }
  return { entries, snapshots: [], version: null }
}

function buildState(
  entries: Record<string, EntryRow[]>,
  snapshots: StatSnapshot[] = [],
  baseVersion = 0,
): StoredState {
  const { cards, modules } = summarize(entries)
  return {
    format: STORAGE_FORMAT,
    version: baseVersion,
    entries,
    stats: { cards, modules },
    // 首次建账就给今天留一份快照，之后重算只动当前口径、不改这条原结论。
    snapshots: ensureTodaySnapshot(snapshots, modules, todayKey()),
  }
}

function seedState(): StoredState {
  return buildState(clone(SEED_ROWS))
}

let cache: StoredState | null = null

function readState(): StoredState {
  if (cache !== null) {
    return cache
  }
  if (!hasStorage()) {
    cache = seedState()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = seedState()
    persist(cache)
    return cache
  }
  const migrated = migrateLegacy(raw)
  if (!migrated) {
    cache = seedState()
    persist(cache)
    return cache
  }
  // 迁移后用当前数据重算一次口径并落账；已是信封的数据沿用其版本与历史快照原结论。
  cache = buildState(migrated.entries, migrated.snapshots, migrated.version ?? 0)
  persist(cache)
  return cache
}

// 唯一落库点：先写 localStorage，写成功才提交内存缓存；失败抛出由事务回滚。
function persist(state: StoredState): void {
  if (!hasStorage()) {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

if (hasStorage()) {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) {
      return
    }
    try {
      const incoming = JSON.parse(event.newValue) as StoredState
      if (incoming.format === STORAGE_FORMAT && (!cache || incoming.version >= cache.version)) {
        cache = incoming
      }
    } catch {
      // 别的标签页写坏的数据不覆盖本页缓存。
    }
  })
}

export function getState(): StoredState {
  return readState()
}

export function allRows(): Record<string, EntryRow[]> {
  return getState().entries
}

export function listRows(key: string): EntryRow[] {
  return getState().entries[key] ?? []
}

export function currentVersion(): number {
  return getState().version
}

type CommitOptions = {
  // 默认每次写入都保证当天快照存在；纯重算当前口径时传 false，不动历史结论。
  stampSnapshot?: boolean
}

// 统一提交事务：乐观锁只接受最后有效版本；统计随业务数据一起算、一起落库；
// 缓存仅在落库成功后替换，落库抛错时保留旧缓存，调用方拿到失败结果即整体回滚。
export function commitRows(
  key: string,
  rows: EntryRow[],
  expectedVersion: number,
  options: CommitOptions = {},
): CommitResult {
  const current = readState()
  if (expectedVersion !== current.version) {
    return {
      ok: false,
      message: '数据已被其他操作更新（版本过期），请刷新后取最新版本再操作',
    }
  }
  const entries = { ...current.entries, [key]: rows }
  const { cards, modules } = summarize(entries)
  const snapshots =
    options.stampSnapshot === false
      ? current.snapshots
      : ensureTodaySnapshot(current.snapshots, modules, todayKey())
  const next: StoredState = {
    format: STORAGE_FORMAT,
    version: current.version + 1,
    entries,
    stats: { cards, modules },
    snapshots,
  }
  try {
    persist(next)
  } catch {
    // 落库失败：不替换 cache，业务动作视为整笔回滚，调用方不得继续按新版本渲染。
    return { ok: false, message: '统计落库失败，本次更新已整体回滚，请重试' }
  }
  cache = next
  return { ok: true, state: next }
}

export function resetRows(key: string, expectedVersion: number): CommitResult {
  return commitRows(key, clone(SEED_ROWS[key] ?? []), expectedVersion)
}

// 概览「重新统计」：当前口径强制重算并落库，版本前进；历史快照维持原结论不变。
export function recomputeStats(expectedVersion: number): CommitResult {
  const current = readState()
  if (expectedVersion !== current.version) {
    return {
      ok: false,
      message: '数据已被其他操作更新（版本过期），请刷新后取最新版本再操作',
    }
  }
  const { cards, modules } = summarize(current.entries)
  const next: StoredState = {
    format: STORAGE_FORMAT,
    version: current.version + 1,
    entries: current.entries,
    stats: { cards, modules },
    snapshots: current.snapshots,
  }
  try {
    persist(next)
  } catch {
    return { ok: false, message: '统计落库失败，重算已回滚，请重试' }
  }
  cache = next
  return { ok: true, state: next }
}

export function storageKey(): string {
  return STORAGE_KEY
}
