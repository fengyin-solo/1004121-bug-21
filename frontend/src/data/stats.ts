import type { EntryRow, ModuleMeta } from './types'

// 没有登记到任何业务模块的存量记录，迁移后统一归到这个桶里。
export const UNCATEGORIZED_KEY = '__uncategorized__'
export const UNCATEGORIZED_NAME = '未分类'

// 会把记录带向异常态的动作词：落库写标记和概览重算都从这一份推导，口径不分叉。
const NEGATIVE_VERBS = [
  '撤销',
  '作废',
  '拒绝',
  '驳回',
  '停用',
  '忽略',
  '下线',
  '回滚',
  '报修',
  '中断',
  '异常',
  '延误',
  '超时',
  '整改',
]

// 指标卡标签里常见的业务后缀/前缀：剥掉之后再跟状态名做匹配。
const METRIC_CORE_SUFFIXES = [
  '航班',
  '设备',
  '车辆',
  '机位',
  '廊桥',
  '记录',
  '人员',
  '问题',
  '事件',
  '行李',
  '除冰',
  '数',
  '率',
]
const METRIC_CORE_PREFIXES = ['今日']

const abnormalStatusCache = new WeakMap<ModuleMeta, Set<string>>()

// 一个模块里哪些状态算异常态：由动作词反推目标状态，动作配置是唯一事实来源。
export function abnormalStatuses(meta: ModuleMeta): Set<string> {
  const cached = abnormalStatusCache.get(meta)
  if (cached) {
    return cached
  }
  const statusSet = new Set<string>()
  for (const [action, target] of Object.entries(meta.actionTargets)) {
    if (NEGATIVE_VERBS.some((verb) => action.includes(verb))) {
      statusSet.add(target)
    }
  }
  abnormalStatusCache.set(meta, statusSet)
  return statusSet
}

export function isAbnormalStatus(meta: ModuleMeta, status: string): boolean {
  return abnormalStatuses(meta).has(status)
}

// 统一口径：待处理 = 还没走到模块最后一个状态；异常 = 动作或落点属于异常态。
// 写入路径用它落标记，重算路径用同一套规则，刷新后读到的就是当时写下的结论。
export function deriveFlags(
  meta: ModuleMeta,
  status: string,
  action?: string,
): { pending: boolean; abnormal: boolean } {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const negativeAction = action
    ? NEGATIVE_VERBS.some((verb) => action.includes(verb))
    : false
  return {
    pending: status !== lastStatus,
    abnormal: negativeAction || isAbnormalStatus(meta, status),
  }
}

export type ModuleSummary = { created: number; pending: number; abnormal: number }

// 概览汇总直接信任落库的标记：历史快照迁过来时结论一行不改，新写入又走同一份推导。
export function summarizeRows(rows: EntryRow[]): ModuleSummary {
  return rows.reduce<ModuleSummary>(
    (summary, row) => {
      summary.created += 1
      if (row.pending) {
        summary.pending += 1
      }
      if (row.abnormal) {
        summary.abnormal += 1
      }
      return summary
    },
    { created: 0, pending: 0, abnormal: 0 },
  )
}

function metricCore(label: string): string {
  let core = label
  for (const prefix of METRIC_CORE_PREFIXES) {
    if (core.startsWith(prefix)) {
      core = core.slice(prefix.length)
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of METRIC_CORE_SUFFIXES) {
      if (core.length > suffix.length && core.endsWith(suffix)) {
        core = core.slice(0, -suffix.length)
        changed = true
      }
    }
  }
  return core
}

// 最长公共子串长度：指标剥壳后和状态名按重合字数配对。
function commonLength(left: string, right: string): number {
  let best = 0
  const dp = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  )
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
        best = Math.max(best, dp[i][j])
      }
    }
  }
  return best
}

function matchStatus(meta: ModuleMeta, label: string): string | null {
  const core = metricCore(label)
  let matched: string | null = null
  let bestScore = 0
  meta.statuses.forEach((status) => {
    const score = commonLength(core, status)
    if (score < bestScore || score < 2) {
      return
    }
    if (score === bestScore && matched !== null) {
      // 并列时（典型：今日巡查 vs 待巡查/已巡查）优先认可已完成的正向状态。
      const currentWins = label.startsWith('今日') && status.startsWith('已') && !matched.startsWith('已')
      if (!currentWins) {
        return
      }
    }
    bestScore = score
    matched = status
  })
  return matched
}

// 各业务模块页头部指标卡：从同一份持久化记录里按状态重算，概览/列表/导出同源。
export function metricCards(
  meta: ModuleMeta,
  rows: EntryRow[],
): { label: string; value: number }[] {
  return meta.metrics.map((label) => {
    if (label.includes('率')) {
      const onDuty = rows.filter((row) => String(row.status) === '在岗').length
      return { label, value: rows.length ? Math.round((onDuty / rows.length) * 100) : 0 }
    }
    const status = matchStatus(meta, label)
    return {
      label,
      value: status
        ? rows.filter((row) => String(row.status) === status).length
        : 0,
    }
  })
}
