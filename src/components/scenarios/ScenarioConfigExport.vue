<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { ElMessageBox } from 'element-plus'
import { useAdminStore } from '../../stores/admin'
import { useAuthStore } from '../../stores/auth'

const store = useAdminStore()
const auth = useAuthStore()
const feedback = computed(() => store.maintenance.export)
const pending = computed(() => ['LOADING', 'VALIDATING', 'EXECUTING'].includes(feedback.value.state))
const classificationLabels = { INTERNAL: '内部使用', LEVEL_II: '二级', LEVEL_III: '三级' }

/** 复用既有一次性确认合同；离开页面或会话失效后不继续导出。 */
async function exportConfig(): Promise<void> {
  if (auth.role !== 'ADMIN' || pending.value) return
  const epoch = store.maintenanceEpoch
  try {
    await ElMessageBox.confirm('确认演示完整配置导出流程？本操作不校验或导出当前场景内容，不生成实际文件。', '完整配置导出流程演示', {
      confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning',
    })
    if (epoch === store.maintenanceEpoch && auth.role === 'ADMIN') await store.runMaintenanceAction('EXPORT')
  } catch { /* 取消确认时不提交请求。 */ }
}

onBeforeUnmount(() => store.resetMaintenance())
</script>

<template>
  <section v-if="auth.role === 'ADMIN'" class="scenario-config-export" aria-label="完整配置导出流程演示" data-testid="scenario-config-export">
    <header><h3>完整配置导出流程演示</h3><el-button :disabled="pending" data-testid="full-config-export" @click="exportConfig">确认并验证导出</el-button></header>
    <p>仅演示固定 FULL-CONFIG 的完整配置导出流程，不校验或导出当前场景内容，不生成实际文件。</p>
    <el-alert v-if="feedback.state !== 'EMPTY' && feedback.message" :title="feedback.message" :type="feedback.state === 'ERROR' ? 'error' : 'info'" :closable="false" />
    <el-descriptions v-if="store.fullConfigExport" :column="1" border data-testid="full-config-result">
      <el-descriptions-item label="数据分级">{{ classificationLabels[store.fullConfigExport.classification] }}</el-descriptions-item>
      <el-descriptions-item label="水印">{{ store.fullConfigExport.watermark }}</el-descriptions-item>
      <el-descriptions-item label="验证时间">{{ store.fullConfigExport.verifiedAt }}</el-descriptions-item>
    </el-descriptions>
  </section>
</template>

<style scoped>
.scenario-config-export { display: grid; gap: 1rem; margin-top: 1rem; }
header { display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; }
h3 { margin: 0; font-size: 1rem; }
</style>
