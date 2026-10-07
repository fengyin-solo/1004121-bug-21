import { SEED_ROWS } from './seed'
import { MODULE_BY_KEY } from './modules'
import { UNCATEGORIZED_KEY } from './stats'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
const SCHEMA = 2

type StoreEnvelope = {
  schema: number
  revision: number
  buckets: Record<string, EntryRow[]>
}

export class PersistError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersistError'
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function normalizeEntry(value: unknown): EntryRow | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  if (!('id' in record)) {
    return null
  }
  const entry: EntryRow = { ...(record as object), id: Number(record.id) } as EntryRow
  // 只补不删：存量记录没有的布尔位补默认值，已有的 pending/abnormal 结论原样保留。
  if (typeof entry.pending !== 'boolean') {
    entry.pending = false
  }
  if (typeof entry.abnormal !== 'boolean') {
    entry.abnormal = false
  }
  return entry
}

function isEnvelope(value: unknown): value is StoreEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.revision === 'number' &&
    typeof record.buckets === 'object' &&
    record.buckets !== null
  )
}

// 存量格式迁移：
// - 旧版直接是 {模块: 记录[]}：包一层版本信封；
// - 缺模块归属的桶整体回填到「未分类」；
// - 已知模块桶缺失时沿用旧版的播种兜底（{ ...种子, ...存量 }），避免升级后意外清空；
// - 历史记录的 pending/abnormal 一行不改，快照结论保留。
function migrateLegacy(raw: unknown): StoreEnvelope {
  const legacy = (raw ?? {}) as Record<string, unknown>
  const buckets: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(clone(SEED_ROWS))) {
    if (Array.isArray(legacy[key])) {
      buckets[key] = (legacy[key] as unknown[])
        .map((item) => normalizeEntry(item))
        .filter((item): item is EntryRow => item !== null)
    } else {
      buckets[key] = rows
    }
  }
  for (const [key, list] of Object.entries(legacy)) {
    if (MODULE_BY_KEY.has(key) || !Array.isArray(list)) {
      continue
    }
    const entries = list
      .map((item) => normalizeEntry(item))
      .filter((item): item is EntryRow => item !== null)
    buckets[UNCATEGORIZED_KEY] = (buckets[UNCATEGORIZED_KEY] ?? []).concat(entries)
  }
  return { schema: SCHEMA, revision: 0, buckets }
}

function seedEnvelope(): StoreEnvelope {
  const buckets: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(clone(SEED_ROWS))) {
    buckets[key] = rows
  }
  return { schema: SCHEMA, revision: 0, buckets }
}

function parseStored(raw: string): StoreEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isEnvelope(parsed)) {
      return parsed
    }
    return migrateLegacy(parsed)
  } catch {
    return null
  }
}

let cache: StoreEnvelope | null = null

function readEnvelope(): StoreEnvelope {
  if (cache !== null) {
    return cache
  }
  if (!storageAvailable()) {
    cache = seedEnvelope()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  let envelope: StoreEnvelope | null = null
  if (raw === null) {
    envelope = seedEnvelope()
  } else {
    envelope = parseStored(raw)
    if (envelope === null) {
      envelope = seedEnvelope()
    }
  }
  cache = envelope
  // 迁移或首次播种后立刻落库；失败不拦页面，仍以内存里这份为准。
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope))
  } catch {
    // 配额/隐私模式下写不进去时不阻断，后续每次提交会再试。
  }
  return envelope
}

// 并发提交时基于磁盘最新版本合并：只接受还找得到编号的有效版本，找不到的旧版本丢弃。
function buildCandidate(
  base: StoreEnvelope,
  key: string,
  rows: EntryRow[],
  mode: 'merge' | 'replace',
): StoreEnvelope {
  if (mode === 'replace') {
    return {
      schema: SCHEMA,
      revision: base.revision + 1,
      buckets: { ...base.buckets, [key]: clone(rows) },
    }
  }
  const baseRows = base.buckets[key] ?? []
  const baseById = new Map(baseRows.map((row) => [Number(row.id), row]))
  const touchedIds = new Set<number>()
  const merged: EntryRow[] = []
  for (const row of rows) {
    const id = Number(row.id)
    if (!baseById.has(id)) {
      // 对端已经删掉或它从未存在：这个陈旧版本不再接受。
      continue
    }
    touchedIds.add(id)
    merged.push(clone(row))
  }
  for (const row of baseRows) {
    if (!touchedIds.has(Number(row.id))) {
      merged.push(row)
    }
  }
  merged.sort((left, right) => Number(left.id) - Number(right.id))
  return {
    schema: SCHEMA,
    revision: base.revision + 1,
    buckets: { ...base.buckets, [key]: merged },
  }
}

// 落库即提交：基于磁盘最新版本重建候选（其他标签页的改动不丢）；
// 写失败重读再试一次，仍失败则连内存缓存一起回滚到提交前。
function commit(
  key: string,
  rows: EntryRow[],
  mode: 'merge' | 'replace',
): StoreEnvelope {
  const snapshot = clone(readEnvelope())
  for (let attempt = 0; ; attempt += 1) {
    const onDisk = storageAvailable()
      ? (() => {
          const raw = window.localStorage.getItem(STORAGE_KEY)
          return raw === null ? snapshot : parseStored(raw) ?? snapshot
        })()
      : snapshot
    const candidate = buildCandidate(onDisk, key, rows, mode)
    cache = candidate
    if (!storageAvailable()) {
      notify()
      return candidate
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate))
      notify()
      return candidate
    } catch (error) {
      // 缓存落库失败：一起回滚到提交前，内存和磁盘保持同一口径。
      cache = snapshot
      if (attempt >= 1) {
        throw new PersistError(
          error instanceof Error ? `数据落库失败，已回滚：${error.message}` : '数据落库失败，已回滚',
        )
      }
    }
  }
}

export function allRows(): Record<string, EntryRow[]> {
  return readEnvelope().buckets
}

export function listRows(key: string): EntryRow[] {
  return readEnvelope().buckets[key] ?? []
}

// 动作流转用 merge：以记录为单位做最后有效版本胜出；整模块重置用 replace。
export function saveRows(key: string, rows: EntryRow[], mode: 'merge' | 'replace' = 'merge'): void {
  commit(key, rows, mode)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows, 'replace')
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---- 订阅：本页提交或其他标签页改动后，让页面按同一份持久化数据重算 ----

type Listener = () => void
const listeners = new Set<Listener>()
let bound = false

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (!bound && typeof window !== 'undefined') {
    bound = true
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) {
        return
      }
      // 对端写坏或清空时不拿空快照覆盖本页内存，避免无端回到示例数据。
      const next = event.newValue !== null ? parseStored(event.newValue) : null
      if (next !== null) {
        cache = next
        notify()
      }
    })
  }
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  listeners.forEach((listener) => listener())
}

// 仅供自动化测试：丢掉内存缓存与订阅，模拟刷新页面后的重新装载，业务代码不要调用。
export function _resetMemoryCacheForTest(): void {
  cache = null
  listeners.clear()
  bound = false
}
