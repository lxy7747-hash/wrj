<script setup lang="ts">
import { computed } from 'vue'
import type { DetectionEvent, Replay, SwitchEvent } from '../../contracts/domain-models'
import type { EngineReplayTimelineMarker, EngineReplayTimelineMarkerKind } from '../../features/replays/engine-replay'
import { replayEventTime } from '../../stores/replay'

type ReplayEvent = DetectionEvent | SwitchEvent

const props = defineProps<{
  replay: Replay
  events: ReplayEvent[]
  engineMarkers?: EngineReplayTimelineMarker[]
  selectedEventId: string | null
}>()

const emit = defineEmits<{
  select: [eventId: string]
  seek: [seconds: number]
}>()

const hasEngineMarkers = computed(() => (props.engineMarkers?.length ?? 0) > 0)

function timePercent(time: number): number {
  return props.replay.durationS === 0 ? 0 : Math.min(100, Math.max(0, time / props.replay.durationS * 100))
}

/** 返回事件在时间轴上的百分比位置。 */
function eventPosition(event: ReplayEvent): number {
  return timePercent(replayEventTime(event))
}

/** 返回侦测或链路切换事件的中文名称。 */
function eventLabel(event: ReplayEvent): string {
  return event.type === 'DETECTION' ? '目标侦测' : '链路切换'
}

function markerKindClass(kind: EngineReplayTimelineMarkerKind): string {
  if (kind === 'SWITCH') return 'is-switch'
  if (kind === 'ALARM' || kind === 'JAMMING') return 'is-jammed'
  return 'is-detection'
}

/** 当前游标处对应的最新关键事件，用于高亮回放进度所处阶段。 */
const activeEngineMarkerId = computed(() => {
  const markers = props.engineMarkers ?? []
  if (!markers.length) return null
  if (props.selectedEventId && markers.some(marker => marker.id === props.selectedEventId && marker.time === props.replay.currentTimeS)) {
    return props.selectedEventId
  }
  const latest = [...markers].reverse().find(marker => marker.time <= props.replay.currentTimeS)
  return latest?.id ?? null
})

function findNextMarker(kinds: ReadonlyArray<EngineReplayTimelineMarkerKind>): EngineReplayTimelineMarker | undefined {
  const candidates = (props.engineMarkers ?? []).filter(marker => kinds.includes(marker.kind))
  if (!candidates.length) return undefined
  return candidates.find(marker => marker.time > props.replay.currentTimeS) ?? candidates[0]
}

const nextJamMarker = computed(() => findNextMarker(['JAMMING', 'ALARM']))
const nextSwitchMarker = computed(() => findNextMarker(['SWITCH']))

/**
 * 选择事件并把游标定位到事件登记时刻。
 * @param event 被用户选择的回放事件。
 */
function selectEvent(event: ReplayEvent): void {
  emit('select', event.eventId)
  emit('seek', replayEventTime(event))
}

function selectEngineMarker(marker: EngineReplayTimelineMarker): void {
  emit('select', marker.id)
  emit('seek', Math.min(props.replay.durationS, Math.max(0, marker.time)))
}
</script>

<template>
  <section class="replay-timeline" aria-label="事件时序" data-testid="replay-timeline">
    <div v-if="hasEngineMarkers" class="replay-timeline__bar">
      <div class="replay-timeline__legend" aria-label="关键事件图例">
        <span><i class="replay-timeline__dot is-detection" aria-hidden="true" />目标侦测</span>
        <span><i class="replay-timeline__dot is-jammed" aria-hidden="true" />受扰 / 告警</span>
        <span><i class="replay-timeline__dot is-switch" aria-hidden="true" />链路切换</span>
      </div>
      <div class="replay-timeline__jumps">
        <button
          v-if="nextJamMarker"
          type="button"
          class="replay-timeline__jump is-jammed"
          data-testid="jump-next-jam"
          @click="selectEngineMarker(nextJamMarker)"
        >跳到受扰（T+{{ Math.round(nextJamMarker.time) }}s）</button>
        <button
          v-if="nextSwitchMarker"
          type="button"
          class="replay-timeline__jump is-switch"
          data-testid="jump-next-switch"
          @click="selectEngineMarker(nextSwitchMarker)"
        >跳到切换（T+{{ Math.round(nextSwitchMarker.time) }}s）</button>
      </div>
    </div>

    <div class="replay-timeline__track" aria-hidden="true">
      <span
        class="replay-timeline__progress"
        :style="{ width: `${replay.durationS === 0 ? 0 : replay.currentTimeS / replay.durationS * 100}%` }"
      />
      <template v-if="hasEngineMarkers">
        <button
          v-for="marker in engineMarkers"
          :key="marker.id"
          type="button"
          class="replay-timeline__marker replay-timeline__marker--engine"
          :class="[markerKindClass(marker.kind), { 'is-selected': marker.id === activeEngineMarkerId }]"
          :style="{ left: `${timePercent(marker.time)}%` }"
          :title="`${marker.label} · ${marker.detail}（T+${Math.round(marker.time)} s）`"
          @click="selectEngineMarker(marker)"
        />
      </template>
      <template v-else>
        <span
          v-for="event in events"
          :key="event.eventId"
          class="replay-timeline__marker"
          :class="{ 'is-selected': event.eventId === selectedEventId }"
          :style="{ left: `${eventPosition(event)}%` }"
        />
      </template>
    </div>

    <div v-if="hasEngineMarkers" class="replay-timeline__events replay-timeline__events--engine" data-testid="replay-engine-markers">
      <button
        v-for="marker in engineMarkers"
        :key="marker.id"
        type="button"
        :class="[markerKindClass(marker.kind), { 'is-selected': marker.id === activeEngineMarkerId }]"
        :title="`${marker.label} · ${marker.detail}（T+${Math.round(marker.time)} s）`"
        @click="selectEngineMarker(marker)"
      >
        <span class="replay-timeline__chip-label">{{ marker.label }}</span>
        <strong>{{ marker.detail }}</strong>
        <small>T+{{ Math.round(marker.time) }} s</small>
      </button>
    </div>
    <div v-else class="replay-timeline__events">
      <button
        v-for="event in events"
        :key="event.eventId"
        type="button"
        :class="{ 'is-selected': event.eventId === selectedEventId }"
        @click="selectEvent(event)"
      >
        <span>{{ eventLabel(event) }}</span>
        <strong>{{ event.eventId }}</strong>
        <small>T+{{ replayEventTime(event) }} s</small>
      </button>
    </div>
  </section>
</template>

<style scoped>
.replay-timeline {
  display: grid;
  gap: 0.6rem;
}

.replay-timeline__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.replay-timeline__legend,
.replay-timeline__jumps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem;
  font-size: 12px;
  color: var(--console-text-muted);
}

.replay-timeline__legend span {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

.replay-timeline__dot {
  display: inline-block;
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
}

.replay-timeline__dot.is-detection,
.replay-timeline__marker.is-detection {
  background: #f5b942;
}

.replay-timeline__dot.is-jammed,
.replay-timeline__marker.is-jammed {
  background: #ff4d6d;
}

.replay-timeline__dot.is-switch,
.replay-timeline__marker.is-switch {
  background: #38e8ff;
}

.replay-timeline__jump {
  padding: 2px 10px;
  border: 1px solid var(--console-border);
  border-radius: 999px;
  background: var(--console-bg-elevated);
  color: var(--console-text);
  font-size: 12px;
  cursor: pointer;
}

.replay-timeline__jump.is-jammed {
  border-color: rgba(255, 77, 109, 0.7);
  color: #ff94a7;
}

.replay-timeline__jump.is-switch {
  border-color: rgba(56, 232, 255, 0.7);
  color: #82f0ff;
}

.replay-timeline__track {
  position: relative;
  height: 0.45rem;
  margin: 0.5rem 0.4rem;
  border-radius: 999px;
  background: var(--console-border);
}

.replay-timeline__progress {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: var(--console-cyan);
}

.replay-timeline__marker {
  position: absolute;
  top: 50%;
  width: 0.8rem;
  height: 0.8rem;
  padding: 0;
  transform: translate(-50%, -50%);
  border: 2px solid var(--console-bg-elevated);
  border-radius: 50%;
  background: var(--console-amber);
}

.replay-timeline__marker--engine {
  cursor: pointer;
}

.replay-timeline__marker.is-selected {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--console-cyan) 40%, transparent);
}

.replay-timeline__events {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.5rem;
}

.replay-timeline__events--engine {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  padding-bottom: 2px;
}

.replay-timeline__events--engine button {
  flex: 0 0 auto;
  min-width: 10.5rem;
  max-width: 16rem;
}

.replay-timeline__events button {
  display: grid;
  gap: 0.15rem;
  padding: 0.5rem 0.65rem;
  border: 1px solid var(--console-border);
  border-radius: 6px;
  color: var(--console-text);
  background: var(--console-surface);
  text-align: left;
  cursor: pointer;
}

.replay-timeline__events button.is-detection {
  border-left: 3px solid #f5b942;
}

.replay-timeline__events button.is-jammed {
  border-left: 3px solid #ff4d6d;
}

.replay-timeline__events button.is-switch {
  border-left: 3px solid #38e8ff;
}

.replay-timeline__events button.is-selected {
  border-color: var(--console-cyan);
  background: color-mix(in srgb, var(--console-cyan) 12%, var(--console-surface));
}

.replay-timeline__events span,
.replay-timeline__events small {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}

.replay-timeline__events strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
</style>
