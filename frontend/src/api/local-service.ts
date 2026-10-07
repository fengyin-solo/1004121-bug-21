import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitRows,
  currentVersion,
  getState,
  listRows,
  recomputeStats,
  resetRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

// 列表入口：筛选只影响展示，登记总量/待处理/异常量始终取随业务数据落库的同一口径。
export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const state = getState()
  const all = state.entries[key] ?? []
  const matched = filterRows(all, filters)
  const stat = state.stats.modules.find((item) => item.key === key)
  return {
    items: matched,
    total: matched.length,
    page: 1,
    size: matched.length,
    registered: stat?.created ?? all.length,
    pending: stat?.pending ?? 0,
    abnormal: stat?.abnormal ?? 0,
    version: state.version,
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedVersion: number = currentVersion(),
): ActionResult {
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
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
    模块归属: meta.name,
  }
  const next = [...rows]
  next[index] = updated
  // 业务数据与统计在同一事务里重算并落库；版本过期或落库失败都整体回滚。
  const result = commitRows(key, next, expectedVersion)
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string, expectedVersion: number = currentVersion()): PageResult {
  const result = resetRows(key, expectedVersion)
  if (!result.ok) {
    throw new Error(result.message)
  }
  return listEntries(key)
}

export function exportEntries(key: string): {
  filename: string
  content: string
  count: number
  registered: number
} {
  const meta = moduleMeta(key)
  const state = getState()
  const rows = state.entries[key] ?? []
  const stat = state.stats.modules.find((item) => item.key === key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return {
    filename: `${meta.name}-清单.csv`,
    content: `\uFEFF${lines.join('\n')}`,
    // 导出入口的登记总量与概览、列表完全一致，按落库口径返回。
    count: rows.length,
    registered: stat?.created ?? rows.length,
  }
}

export function downloadEntries(key: string): { count: number; registered: number } {
  const { filename, content, count, registered } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return { count, registered }
}

// 概览入口：直接读随业务数据落库的统计，不再临时各算各的。
export function loadOverview(): OverviewResult {
  const state = getState()
  return {
    cards: state.stats.cards,
    modules: state.stats.modules,
    snapshots: state.snapshots,
    version: state.version,
  }
}

// 概览「重新统计」：当前口径重算并落库，历史快照保留原结论。
export function recomputeOverview(expectedVersion: number = currentVersion()): {
  ok: boolean
  message: string
  overview?: OverviewResult
} {
  const result = recomputeStats(expectedVersion)
  if (!result.ok) {
    return { ok: false, message: result.message }
  }
  const state = result.state
  return {
    ok: true,
    message: '统计口径已重算并同步落库',
    overview: {
      cards: state.stats.cards,
      modules: state.stats.modules,
      snapshots: state.snapshots,
      version: state.version,
    },
  }
}
