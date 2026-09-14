<script setup lang="ts">
import { computed } from 'vue'
import type { Link, ScenarioDraft } from '../../contracts/domain-models'
import OfflineSituationMap from './OfflineSituationMap.vue'
import type { SituationMapFocusTarget } from './situation-map-controller'
import { readLinkEnabled } from '../../features/scenarios/link-settings'

const props = defineProps<{ scene: ScenarioDraft; selectedNodeId: string; focusTarget: SituationMapFocusTarget | null }>()
defineEmits<{ 'select-node': [id: string]; 'select-configured-link': [link: Link] }>()
const links = computed(() => props.scene.config.links.map(link => ({ ...link, enabled: readLinkEnabled(link, props.scene.config.linkSettings) })))
// 配置预览只投影初始坐标，不推进位置、不合成遥测质量或运行轨迹。
const nodes = computed(() => props.scene.config.platforms.map(platform => ({
  platformId: platform.id, name: platform.name, type: platform.type,
  ...platform.initialPosition, speed: 0,
})))
</script>

<template>
  <section class="saved-scene" data-testid="saved-scene-preview" aria-label="已选场景配置预览">
    <OfflineSituationMap :key="`${scene.config.scenario.id}-${scene.revision}`" :frame="null" :initial-nodes="nodes" :links="[]"
      :configured-links="links" :selected-node-id="selectedNodeId" :focus-target="focusTarget"
      @select-node="$emit('select-node', $event)" @select-configured-link="$emit('select-configured-link', $event)" />
  </section>
</template>

<style scoped>
.saved-scene { display: grid; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
</style>
