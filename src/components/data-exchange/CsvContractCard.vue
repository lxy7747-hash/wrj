<script setup lang="ts">
import { ref, watch } from 'vue'
import { useDataExchangeStore } from '../../stores/data-exchange'
import DataExchangeStateTag from './DataExchangeStateTag.vue'

const store = useDataExchangeStore()
const contractName = ref('')
const csvText = ref('')

/** 将当前合同的内存示例载入文本区。 */
function loadExample(): void {
  csvText.value = store.createCsvExample(contractName.value)
  store.csvState = 'EMPTY'
  store.csvMessage = csvText.value === '' ? '未找到所选 CSV 合同。' : '已加载内存示例，尚未执行校验。'
}

/** 校验当前文本的表头、编码和字段类型。 */
async function validate(): Promise<void> {
  await store.validateCsv(contractName.value, csvText.value)
}

watch(() => store.csvContracts, (contracts) => {
  if (!contracts.some((item) => item.name === contractName.value)) contractName.value = contracts[0]?.name ?? ''
}, { immediate: true })
</script>

<template>
  <el-card id="de-cap-csvdx" class="exchange-card" shadow="never" data-testid="csv-contract-card">
    <template #header>
      <div class="exchange-card__header">
        <div><p class="eyebrow">T-XQ-022 · VISIBLE_CONTRACT</p><h3>CSV 文件读写合同</h3></div>
        <DataExchangeStateTag :state="store.csvState" data-testid="csv-state" />
      </div>
    </template>
    <p class="exchange-card__description">校验三个 canonical CSV 的表头、UTF-8 文本和字段类型；本阶段不读取或写入文件。</p>
    <el-form label-position="top">
      <el-form-item label="CSV 合同">
        <el-select v-model="contractName" data-testid="csv-contract-select">
          <el-option v-for="contract in store.csvContracts" :key="contract.name" :label="contract.name" :value="contract.name" />
        </el-select>
      </el-form-item>
      <el-form-item label="内存 CSV 文本">
        <el-input v-model="csvText" type="textarea" :rows="6" data-testid="csv-text" />
      </el-form-item>
    </el-form>
    <div class="exchange-card__actions">
      <el-button @click="loadExample">加载合同示例</el-button>
      <el-button type="primary" @click="validate">校验 CSV</el-button>
    </div>
    <el-alert class="exchange-card__result" :type="store.csvState === 'ERROR' ? 'error' : 'info'" :closable="false" :title="store.csvMessage" />
    <el-table v-if="store.csvResult?.issues.length" :data="store.csvResult.issues" size="small" data-testid="csv-issues">
      <el-table-column prop="row" label="行号" width="70" />
      <el-table-column prop="code" label="错误码" min-width="140" />
      <el-table-column prop="fieldPath" label="字段路径" min-width="150" />
      <el-table-column prop="message" label="说明" min-width="220" />
    </el-table>
    <p v-if="store.csvResult" class="exchange-card__note">原子写入：未执行 · 临时文件：未创建 · 目标文件：未改变</p>
  </el-card>
</template>
