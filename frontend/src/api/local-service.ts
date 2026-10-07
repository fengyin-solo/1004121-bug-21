import { MODULE_BY_KEY, MODULES } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  deriveFlags,
  metricCards,
  summarizeRows,
  UNCATEGORIZED_KEY,
  UNCATEGORIZED_NAME,
} from '@/data/stats'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const all = listRows(key)
  const matched = filterRows(all, filters)
  // total 始终是登记总量（与概览、导出一致）；items 才是筛选后当前页的记录。
  return { items: matched, total: all.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 待处理/异常标记与概览重算共用 deriveFlags 一份口径，写下去什么重算就是什么。
  const flags = deriveFlags(meta, target, action)
  const updated: EntryRow = { ...rows[index], status: target, ...flags }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : '数据落库失败，本次操作已回滚',
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 导出与列表、概览读同一份持久化记录，总量不再是两套数。
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 业务模块页头部指标卡：和概览同源，动作落库后刷新页面仍是同一份口径。
export function moduleStats(key: string): { label: string; value: number }[] {
  return metricCards(moduleMeta(key), listRows(key))
}

export function loadOverview(): OverviewResult {
  const buckets = allRows()
  const modules = MODULES.map((meta) => {
    const summary = summarizeRows(buckets[meta.key] ?? [])
    return { name: meta.name, ...summary }
  })
  const uncategorized = buckets[UNCATEGORIZED_KEY] ?? []
  if (uncategorized.length > 0) {
    modules.push({ name: UNCATEGORIZED_NAME, ...summarizeRows(uncategorized) })
  }
  const cards = [
    { label: '业务模块', value: MODULES.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
