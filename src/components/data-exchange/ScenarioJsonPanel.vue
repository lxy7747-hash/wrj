<script setup lang="ts">
import { ref } from 'vue'
import { useDataExchangeStore } from '../../stores/data-exchange'
import { useScenarioStore } from '../../stores/scenario'
import DataExchangeStateTag from './DataExchangeStateTag.vue'

const store = useDataExchangeStore()
const scenarioStore = useScenarioStore()
const jsonText = ref('')

/** 加载当前场景的 canonical JSON，不包含界面扩展字段。 */
async function loadCurrentScenario(): Promise<void> {
  if (scenarioStore.draft === null && !await scenarioStore.loadScenario()) {
    store.jsonState = 'ERROR'
    store.jsonMessage = scenarioStore.resultMessage
    return
  }
  jsonText.value = scenarioStore.draft === null ? '' : JSON.stringify(scenarioStore.draft.config, null, 2)
  store.jsonState = 'EMPTY'
  store.jsonMessage = jsonText.value === '' ? '当前没有可加载的场景。' : '已加载当前场景 JSON，尚未执行解析。'
}

/** 解析文本并执行完整 ScenarioConfig 1.0 校验。 */
async function parseJson(): Promise<void> {
  await store.parseScenarioJson(jsonText.value)
}
</script>

<template>
  <el-card id="de-cap-jsonjx" class="exchange-card" shadow="never" data-testid="scenario-json-panel">
    <template #header>
      <div class="exchange-card__header">
        <div><p class="eyebrow">T-XQ-023 · INTERACTIVE_UI</p><h3>JSON 配置解析</h3></div>
        <DataExchangeStateTag :state="store.jsonState" data-testid="json-state" />
      </div>
    </template>
    <p class="exchange-card__description">解析 ScenarioConfig 1.0；未知版本、未知字段、缺失字段、重复 ID 和断引用均返回字段路径。</p>
    <el-input v-model="jsonText" type="textarea" :rows="10" aria-label="场景 JSON 文本" data-testid="scenario-json-text" />
    <div class="exchange-card__actions">
      <el-button @click="loadCurrentScenario">加载当前场景</el-button>
      <el-button type="primary" @click="parseJson">解析 JSON</el-button>
    </div>
    <el-alert class="exchange-card__result" :type="store.jsonState === 'ERROR' ? 'error' : 'info'" :closable="false" :title="store.jsonMessage" />
    <el-table v-if="store.jsonValidation.errors.length || store.jsonValidation.warnings.length" :data="[...store.jsonValidation.errors, ...store.jsonValidation.warnings]" size="small" data-testid="json-issues">
      <el-table-column prop="severity" label="级别" width="80" />
      <el-table-column prop="code" label="错误码" min-width="150" />
      <el-table-column prop="fieldPath" label="字段路径" min-width="160" />
      <el-table-column prop="message" label="说明" min-width="220" />
    </el-table>
    <p v-if="store.jsonResult" class="exchange-card__note">输出：{{ store.jsonResult.scenario.id }} · {{ store.jsonResult.platforms.length }} 个场景实体 · 未修改场景草稿</p>
  </el-card>
</template>
