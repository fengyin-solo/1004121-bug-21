/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type ModuleStat = {
  key: string
  name: string
  created: number
  pending: number
  abnormal: number
}

export type StatCard = { label: string; value: number }

/** 历史快照：按日期只追加，重算不覆盖，保留当日原结论。 */
export type StatSnapshot = {
  date: string
  created: number
  pending: number
  abnormal: number
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
  /** 登记总量：不受筛选条件影响，三个入口共用同一份持久化口径。 */
  registered: number
  pending: number
  abnormal: number
  /** 当前数据版本，并发更新时做乐观锁校验。 */
  version: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: StatCard[]
  modules: ModuleStat[]
  snapshots: StatSnapshot[]
  version: number
}

/** localStorage 信封：业务数据、统计口径、历史快照一次落库，保证同生共死。 */
export type StoredState = {
  format: 2
  version: number
  entries: Record<string, EntryRow[]>
  stats: {
    cards: StatCard[]
    modules: ModuleStat[]
  }
  snapshots: StatSnapshot[]
}
