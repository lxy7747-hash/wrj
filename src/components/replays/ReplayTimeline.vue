<script setup lang="ts">
import type { DetectionEvent, Replay, SwitchEvent } from '../../contracts/domain-models'
import { replayEventTime } from '../../stores/replay'

type ReplayEvent = DetectionEvent | SwitchEvent

const props = defineProps<{
  replay: Replay
  events: ReplayEvent[]
  selectedEventId: string | null
}>()

const emit = defineEmits<{
  select: [eventId: string]
  seek: [seconds: number]
}>()

/** 返回事件在时间轴上的百分比位置。 */
function eventPosition(event: ReplayEvent): number {
  return props.replay.durationS === 0 ? 0 : replayEventTime(event) / props.replay.durationS * 100
}

/** 返回侦测或链路切换事件的中文名称。 */
function eventLabel(event: ReplayEvent): string {
  return event.type === 'DETECTION' ? '目标侦测' : '链路切换'
}

/**
 * 选择事件并把游标定位到事件登记时刻。
 * @param event 被用户选择的回放事件。
 */
function selectEvent(event: ReplayEvent): void {
  emit('select', event.eventId)
  emit('seek', replayEventTime(event))
}
</script>

<template>
  <section class="replay-timeline" aria-label="事件时序" data-testid="replay-timeline">
    <div class="replay-timeline__track" aria-hidden="true">
      <span
        class="replay-timeline__progress"
        :style="{ width: `${replay.durationS === 0 ? 0 : replay.currentTimeS / replay.durationS * 100}%` }"
      />
      <span
        v-for="event in events"
        :key="event.eventId"
        class="replay-timeline__marker"
        :class="{ 'is-selected': event.eventId === selectedEventId }"
        :style="{ left: `${eventPosition(event)}%` }"
      />
    </div>

    <div class="replay-timeline__events">
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
  gap: 0.75rem;
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

.replay-timeline__marker.is-selected {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--console-cyan) 35%, transparent);
}

.replay-timeline__events {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.5rem;
}

.replay-timeline__events button {
  display: grid;
  gap: 0.15rem;
  padding: 0.6rem;
  border: 1px solid var(--console-border);
  border-radius: 6px;
  color: var(--console-text);
  background: var(--console-surface);
  text-align: left;
  cursor: pointer;
}

.replay-timeline__events button:hover,
.replay-timeline__events button:focus-visible,
.replay-timeline__events button.is-selected {
  border-color: var(--console-cyan);
  outline: none;
}

.replay-timeline__events span,
.replay-timeline__events small {
  color: var(--console-text-muted);
  font-size: var(--console-font-size-min);
}
</style>
