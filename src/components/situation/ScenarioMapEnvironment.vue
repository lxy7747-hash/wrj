<script setup lang="ts">
import { computed } from 'vue'
import type { Environment } from '../../contracts/domain-models'
import { readNaturalEnvironment } from '../../features/scenarios/link-calc-defaults'
import { SCENARIO_BASIC_DEFAULTS } from '../../features/scenarios/scenario-basic'

const props = defineProps<{ environment: Environment }>()

const environment = computed(() => readNaturalEnvironment(props.environment))
const cloudBottom = computed(() => environment.value.cloudAltitudeMinM ?? SCENARIO_BASIC_DEFAULTS.cloudAltitudeMinM)
const cloudTop = computed(() => environment.value.cloudAltitudeMaxM ?? SCENARIO_BASIC_DEFAULTS.cloudAltitudeMaxM)
const cloudWaterDensity = computed(() => environment.value.cloudWaterDensityGM3 ?? SCENARIO_BASIC_DEFAULTS.cloudWaterDensityGM3)
</script>

<template>
  <section class="scene-map-environment" aria-label="场景环境" data-testid="scene-map-environment">
    <details v-if="environment.cloudEnabled" class="scene-map-environment__cloud">
      <summary class="scene-map-environment__card" data-testid="scene-map-cloud-label">
        <span>云层高度</span>
        <strong>{{ cloudBottom }}–{{ cloudTop }} m</strong>
      </summary>
      <div class="scene-map-environment__profile" data-testid="scene-map-cloud-profile">
        <strong>云层剖面</strong>
        <dl class="scene-map-environment__altitudes">
          <div><dt>云顶</dt><dd>{{ cloudTop }} m</dd></div>
          <div><dt>云底</dt><dd>{{ cloudBottom }} m</dd></div>
        </dl>
        <div>云中含水量 {{ cloudWaterDensity }} g/m³</div>
      </div>
    </details>
    <div v-else class="scene-map-environment__card scene-map-environment__cloud" data-testid="scene-map-cloud-label">
      <span>云层高度</span>
      <strong>云层模型关闭</strong>
    </div>

    <div class="scene-map-environment__card scene-map-environment__sea" data-testid="scene-map-sea-label">
      <span>场景海况</span>
      <strong>{{ environment.seaState === 0 ? '不启用海况损耗' : `${environment.seaState} 级` }}</strong>
    </div>
  </section>
</template>

<style scoped>
.scene-map-environment {
  position: relative;
  display: flex;
  max-width: 100%;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  color: var(--console-text);
  font-size: var(--console-font-size-min);
  line-height: 1.4;
  pointer-events: none;
}

.scene-map-environment__card,
.scene-map-environment__profile {
  box-sizing: border-box;
  border: 1px solid var(--console-border);
  border-radius: 5px;
  background: var(--console-bg-elevated);
}

.scene-map-environment__card {
  max-width: 100%;
  padding: 0.3rem 0.45rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0 0.35rem;
  border-inline-start: 2px solid var(--weather-accent);
}

.scene-map-environment__card span,
.scene-map-environment__profile > strong {
  color: var(--weather-accent);
}

.scene-map-environment strong,
.scene-map-environment dd {
  font-variant-numeric: tabular-nums;
}

.scene-map-environment__sea { --weather-accent: var(--console-cyan); }

.scene-map-environment__cloud {
  --weather-accent: #d0b5ff;
  max-width: 100%;
}

.scene-map-environment__cloud summary {
  cursor: pointer;
  pointer-events: auto;
}

.scene-map-environment__cloud summary::after {
  width: 0.35rem;
  height: 0.35rem;
  margin-inline: 0.12rem;
  border: solid var(--weather-accent);
  border-width: 0 1px 1px 0;
  transform: rotate(45deg);
  content: '';
}

.scene-map-environment__cloud[open] summary::after { transform: rotate(225deg); }
.scene-map-environment__cloud summary:focus-visible { outline: 1px solid var(--weather-accent); }

.scene-map-environment__profile {
  position: absolute;
  z-index: 1;
  inset: calc(100% + 0.375rem) auto auto 0;
  width: max-content;
  max-width: 100%;
  padding: 0.5rem 0.65rem;
}

.scene-map-environment__altitudes {
  position: relative;
  display: grid;
  gap: 0.6rem;
  margin: 0.4rem 0;
  padding-inline-start: 2rem;
}

.scene-map-environment__altitudes::before {
  position: absolute;
  inset: 0.4rem auto 0.4rem 0;
  width: 1.5rem;
  border-block: 1px solid var(--weather-accent);
  background: rgb(158 108 255 / 25%);
  content: '';
}

.scene-map-environment__altitudes div { display: flex; flex-wrap: wrap; gap: 0 0.35rem; }
.scene-map-environment__altitudes dt { color: var(--console-text-muted); }
.scene-map-environment__altitudes dd { margin: 0; }
</style>
