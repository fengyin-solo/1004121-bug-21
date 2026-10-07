import { MODULES, MODULE_BY_KEY, UNCATEGORIZED_MODULE } from './modules'
import type { EntryRow, ModuleStat, StatCard, StatSnapshot } from './types'

// 全系统唯一的统计口径：概览入口、列表入口、导出入口、航班保障页都从这里取数，
// 由数据层在每次写入时算好并随业务数据同一次持久化，刷新后不再出现两套数字。

export function summarizeModules(entries: Record<string, EntryRow[]>): ModuleStat[] {
  const stats = MODULES.map((meta) => {
    const rows = entries[meta.key] ?? []
    return {
      key: meta.key,
      name: meta.name,
      created: rows.length,
      pending: rows.filter((row) => row.pending === true).length,
      abnormal: rows.filter((row) => row.abnormal === true).length,
    }
  })
  // 未分类只在存量迁移实际产生记录时出现，且始终排在最后。
  const looseRows = entries[UNCATEGORIZED_MODULE.key]
  if (looseRows && looseRows.length > 0) {
    stats.push({
      key: UNCATEGORIZED_MODULE.key,
      name: UNCATEGORIZED_MODULE.name,
      created: looseRows.length,
      pending: looseRows.filter((row) => row.pending === true).length,
      abnormal: looseRows.filter((row) => row.abnormal === true).length,
    })
  }
  return stats
}

export function summarizeCards(modules: ModuleStat[]): StatCard[] {
  // 业务模块卡片只数已注册模块，未分类兜底不冒充正式模块。
  const registeredModuleCount = modules.filter(
    (item) => MODULE_BY_KEY.has(item.key) && item.key !== UNCATEGORIZED_MODULE.key,
  ).length
  return [
    { label: '业务模块', value: registeredModuleCount },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
}

export function summarize(entries: Record<string, EntryRow[]>): {
  cards: StatCard[]
  modules: ModuleStat[]
} {
  const modules = summarizeModules(entries)
  return { modules, cards: summarizeCards(modules) }
}

export function findSnapshot(snapshots: StatSnapshot[], date: string): StatSnapshot | undefined {
  return snapshots.find((item) => item.date === date)
}

// 历史快照 append-only：当天已有结论就保留原结论，重算不覆盖；跨天另开一条。
export function ensureTodaySnapshot(
  snapshots: StatSnapshot[],
  modules: ModuleStat[],
  date: string,
): StatSnapshot[] {
  if (findSnapshot(snapshots, date)) {
    return snapshots
  }
  const next: StatSnapshot = {
    date,
    created: modules.reduce((sum, item) => sum + item.created, 0),
    pending: modules.reduce((sum, item) => sum + item.pending, 0),
    abnormal: modules.reduce((sum, item) => sum + item.abnormal, 0),
  }
  return [...snapshots, next].sort((a, b) => (a.date < b.date ? -1 : 1))
}
