import assert from 'node:assert'
import { SEED_ROWS } from '../src/data/seed'
import { MODULES } from '../src/data/modules'
import {
  _resetMemoryCacheForTest,
  allRows,
  listRows,
  resetRows,
  saveRows,
} from '../src/data/local-store'
import {
  exportEntries,
  listEntries,
  loadOverview,
  moduleStats,
  runAction,
} from '../src/api/local-service'
import { summarizeRows } from '../src/data/stats'

const KEY = 'airport-ground-handling:entries'

const store = new Map<string, string>()
let alwaysFail = false

;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (alwaysFail) {
        throw new Error('QuotaExceededError')
      }
      store.set(k, v)
    },
    removeItem: (k: string) => void store.delete(k),
  },
  addEventListener: () => {},
}

// 模拟刷新页面：清掉内存缓存，让所有读路径重新从磁盘装载。
function reopen(): void {
  _resetMemoryCacheForTest()
}

function reset(): void {
  store.clear()
  alwaysFail = false
  reopen()
}

let count = 0
function ok(name: string, check: () => void): void {
  check()
  count += 1
  console.log('  ok -', name)
}

// ---- 1. 存量迁移：未知模块回填未分类，历史标记原结论保留 ----
reset()
store.set(
  KEY,
  JSON.stringify({
    stand: [
      // 历史快照：按现在的规则「已分配」不该算异常，但迁移只补不改
      { id: 91, status: '已分配', pending: false, abnormal: false, 机位编号: 'OLD-1' },
      { id: 92, status: '占用中' }, // 缺布尔位：只补默认值
    ],
    old_system: [
      { id: 1, status: '待处理', pending: true, abnormal: true, name: '陈年记录' },
      { id: 2, status: '待处理', pending: false, abnormal: false, name: '陈年记录2' },
    ],
  }),
)
reopen()
{
  const buckets = allRows() as any
  assert.ok(buckets.stand, '已知模块留在原桶')
  assert.equal(buckets.stand[0].abnormal, false, '历史异常结论不改写')
  assert.equal(buckets.stand[0].pending, false, '历史待处理结论不改写')
  assert.equal(buckets.stand[1].pending, false, '缺失布尔位补默认 false')
  assert.equal(buckets.stand[1].abnormal, false, '缺失异常位补默认 false')
  assert.equal(buckets.__uncategorized__.length, 2, '缺模块归属回填到未分类')
  assert.equal(buckets.__uncategorized__[0].abnormal, true, '未分类记录结论保留')
  assert.equal(JSON.parse(store.get(KEY)!).revision, 0, '迁移后落成版本信封')
  count += 1
  console.log('  ok - 存量迁移与历史快照保留')
}

// ---- 2. 概览/列表/导出同一口径 ----
reset()
{
  const overview = loadOverview()
  const byName = new Map(overview.modules.map((m) => [m.name, m]))
  let totalPending = 0
  let totalAbnormal = 0
  for (const meta of MODULES) {
    const row = byName.get(meta.name)!
    assert.ok(row, `概览含模块 ${meta.name}`)
    const listTotal = listEntries(meta.key).total
    const filtered = listEntries(meta.key, { [meta.fields[0]]: '__不可能命中__' })
    assert.equal(filtered.total, listTotal, `${meta.name} 筛选后 total 仍是登记总量`)
    assert.equal(filtered.items.length, 0, `${meta.name} 筛选只影响 items`)
    const exported = exportEntries(meta.key).content.trim().split('\n').length - 1
    assert.equal(row.created, listTotal, `${meta.name} 概览总量=列表总量`)
    assert.equal(row.created, exported, `${meta.name} 概览总量=导出行数`)
    assert.equal(row.created, SEED_ROWS[meta.key].length, `${meta.name} 播种数量`)
    totalPending += row.pending
    totalAbnormal += row.abnormal
  }
  const card = Object.fromEntries(overview.cards.map((c) => [c.label, c.value]))
  assert.equal(card['登记总量'], MODULES.length * 3)
  assert.equal(card['待处理'], totalPending)
  assert.equal(card['异常量'], totalAbnormal)
  count += 1
  console.log('  ok - 概览/列表/导出登记总量同一套；卡片为各模块实算合计')
}

// ---- 3. 写入即同口径重算；刷新后一致；航班保障清单同步 ----
reset()
{
  const before = loadOverview()
  const beforeCard = Object.fromEntries(before.cards.map((c) => [c.label, c.value]))
  assert.equal(runAction('flight_ops', 1, '标记延误').ok, true)
  {
    const row = listRows('flight_ops').find((r) => r.id === 1)!
    assert.equal(row.status, '已延误')
    assert.equal(row.pending, false, '已延误是该模块终态，统一按终态口径脱离待处理')
    assert.equal(row.abnormal, true, '延误动作落异常标记')
  }
  assert.equal(runAction('flight_ops', 2, '确认就绪').ok, true)
  {
    const row = listRows('flight_ops').find((r) => r.id === 2)!
    assert.equal(row.pending, true, '已就绪不是终态（已延误才是），按统一口径仍待处理')
    assert.equal(row.abnormal, false, '就绪清异常')
  }

  const after = loadOverview()
  const afterCard = Object.fromEntries(after.cards.map((c) => [c.label, c.value]))
  assert.equal(afterCard['登记总量'], beforeCard['登记总量'], '流转不改总量')
  assert.equal(afterCard['待处理'], beforeCard['待处理'] - 1, 'id1 脱离待处理，id2 保持待处理')
  assert.equal(afterCard['异常量'], beforeCard['异常量'], 'id1 新增异常与 id2 清除异常抵消')

  // 模拟刷新：丢弃内存缓存，重新从磁盘装载后再算一遍
  reopen()
  assert.deepStrictEqual(loadOverview(), after, '刷新页面后概览与写入后完全一致')
  const flightStats = Object.fromEntries(
    moduleStats('flight_ops').map((s) => [s.label, s.value]),
  )
  assert.equal(flightStats['延误航班'], 1)
  assert.equal(flightStats['保障中航班'], 0)
  assert.equal(flightStats['待保障航班'], 0)
  count += 1
  console.log('  ok - 写入即同口径重算，刷新后一致，航班保障清单指标同步')
}

// ---- 4. 落库失败整体回滚 ----
reset()
{
  // 先触发一次读，让播种/迁移完成落盘，再记录磁盘基线
  const rowsBefore = JSON.stringify(listRows('stand'))
  const diskBefore = store.get(KEY)!
  alwaysFail = true
  const result = runAction('stand', 1, '分配机位')
  alwaysFail = false
  assert.equal(result.ok, false, '落库失败时动作返回失败')
  assert.match(result.message, /回滚/)
  assert.equal(JSON.stringify(listRows('stand')), rowsBefore, '内存缓存回滚到提交前')
  assert.equal(store.get(KEY), diskBefore, '磁盘数据未变')
  count += 1
  console.log('  ok - 缓存落库失败一起回滚')
}

// ---- 5. 并发更新：最后有效版本胜出，过期版本丢弃 ----
reset()
{
  // 标签页 B 先提交：id=2 改为已到达，revision +1
  const otherTabRows = listRows('baggage').map((r) =>
    r.id === 2 ? { ...r, status: '已到达', pending: false, abnormal: false } : r,
  )
  const env = JSON.parse(store.get(KEY)!)
  env.revision += 1
  env.buckets.baggage = otherTabRows
  store.set(KEY, JSON.stringify(env))

  // 标签页 A 持旧视图：改 id=1，并夹带一个磁盘上已不存在的 id=99
  const staleA = [
    { ...listEntries('baggage').items[0], status: '转运中', pending: true, abnormal: false },
    { id: 99, status: '已到达', pending: false, abnormal: false } as any,
  ]
  saveRows('baggage', staleA)

  const merged = listRows('baggage')
  const byId = new Map(merged.map((r) => [r.id, r]))
  assert.equal(byId.get(1)!.status, '转运中', 'A 对 id1 的最后有效版本被接受')
  assert.equal(byId.get(2)!.status, '已到达', 'B 对 id2 的改动保留')
  assert.ok(!byId.has(99), '过期版本里磁盘已不存在的记录被丢弃')
  assert.equal(merged.length, 3)
  assert.equal(JSON.parse(store.get(KEY)!).revision, env.revision + 1, '按磁盘最新 revision 递增')

  resetRows('baggage')
  assert.equal(listRows('baggage').length, SEED_ROWS.baggage.length, '整模块重置走 replace')
  count += 1
  console.log('  ok - 并发 CAS 合并：最后有效版本胜出，陈旧版本丢弃，重置为整桶替换')
}

// ---- 6. 未分类桶进入概览 ----
reset()
{
  store.set(
    KEY,
    JSON.stringify({ mystery: [{ id: 1, status: 'x', pending: true, abnormal: true }] }),
  )
  reopen()
  const overview = loadOverview()
  const uncat = overview.modules.find((m) => m.name === '未分类')!
  assert.ok(uncat, '概览含未分类行')
  assert.deepStrictEqual([uncat.created, uncat.pending, uncat.abnormal], [1, 1, 1])
  const card = Object.fromEntries(overview.cards.map((c) => [c.label, c.value]))
  assert.equal(card['登记总量'], MODULES.length * 3 + 1, '未分类之外的已知模块沿用播种兜底')
  assert.equal(card['业务模块'], MODULES.length, '未分类不计入业务模块数')
  count += 1
  console.log('  ok - 未分类存量进入概览但不计业务模块数')
}

// ---- 7. 18 个模块指标卡同源可算 ----
reset()
{
  for (const meta of MODULES) {
    const cards = moduleStats(meta.key)
    assert.equal(cards.length, 3, `${meta.name} 三张指标卡`)
    if (!meta.metrics.some((l) => l.includes('率'))) {
      const sum = cards.reduce((s, c) => s + c.value, 0)
      assert.ok(sum <= listEntries(meta.key).total, `${meta.name} 指标计数不超过总量`)
    }
    cards.forEach((c) => assert.ok(Number.isFinite(c.value)))
  }
  const crew = Object.fromEntries(moduleStats('crew_schedule').map((c) => [c.label, c.value]))
  assert.ok(crew['今日到岗率'] >= 0 && crew['今日到岗率'] <= 100)
  // summarizeRows 与概览口径一致
  const standSummary = summarizeRows(listRows('stand'))
  assert.equal(standSummary.created, 3)
  count += 1
  console.log('  ok - 18 个模块页指标卡同源可算，比率卡有界')
}

console.log(`\n${count} scenarios passed`)
