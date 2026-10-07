<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.key">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <section v-if="snapshots.length" class="snapshot-block">
      <h3>历史快照</h3>
      <p class="page-desc">按日留档，重新统计只更新当前口径，不覆盖当日已保存的结论。</p>
      <table class="data-table">
        <thead>
          <tr><th>快照日期</th><th>登记总量</th><th>待处理</th><th>异常量</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in snapshotRows" :key="item.date">
            <td>{{ item.date }}</td>
            <td>{{ item.created }}</td>
            <td>{{ item.pending }}</td>
            <td>{{ item.abnormal }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据 · 当前版本 v{{ version }}</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { loadOverview, recomputeOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const snapshots = ref<OverviewResult['snapshots']>([])
const version = ref(0)
const message = ref('')
const messageOk = ref(false)

// 历史快照最新在前展示，底层数组仍按日期升序留档。
const snapshotRows = computed(() => [...snapshots.value].reverse())

function applyOverview(payload: OverviewResult) {
  cards.value = payload.cards
  moduleRows.value = payload.modules
  snapshots.value = payload.snapshots
  version.value = payload.version
}

function refresh() {
  message.value = ''
  // 先取最新落库版本再提交：并发下只接受最后有效版本，过期会提示并回显最新口径。
  const latest = loadOverview()
  const result = recomputeOverview(latest.version)
  if (!result.ok || !result.overview) {
    messageOk.value = false
    message.value = result.message
    applyOverview(loadOverview())
    return
  }
  messageOk.value = true
  message.value = result.message
  applyOverview(result.overview)
}

onMounted(() => applyOverview(loadOverview()))
</script>
