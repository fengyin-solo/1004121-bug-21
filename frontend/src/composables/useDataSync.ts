import { onBeforeUnmount, onMounted } from 'vue'

import { subscribe } from '@/data/local-store'

// 数据落库（含其他标签页的改动）后统一触发一次重读：页面不再各自持有陈旧副本。
export function useDataSync(reload: () => void): void {
  let unsubscribe: (() => void) | null = null
  onMounted(() => {
    unsubscribe = subscribe(reload)
  })
  onBeforeUnmount(() => {
    unsubscribe?.()
  })
}
