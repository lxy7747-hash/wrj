import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import ReplayTimeline from '../../src/components/replays/ReplayTimeline.vue'
import type { DetectionEvent, Replay, SwitchEvent } from '../../src/contracts/domain-models'

describe('ReplayTimeline', () => {
  it('renders detection and switch events at their registry times, highlights the selection, and seeks when selected', async () => {
    const replay = { ...(fixtureSource.replay as Replay), durationS: 2_520, currentTimeS: 1_260 }
    const events = fixtureSource.events as Array<DetectionEvent | SwitchEvent>
    const wrapper = mount(ReplayTimeline, { props: { replay, events, selectedEventId: 'SW-003' } })

    expect(wrapper.get('.replay-timeline__progress').attributes('style')).toContain('width: 50%')
    expect(wrapper.findAll('.replay-timeline__marker').map(marker => marker.attributes('style'))).toEqual([
      expect.stringContaining('left: 87.3015873015873%'),
      expect.stringContaining('left: 99.92063492063492%'),
      expect.stringContaining('left: 100%'),
    ])
    expect(wrapper.text()).toContain('目标侦测')
    expect(wrapper.text()).toContain('链路切换')
    expect(wrapper.findAll('button.is-selected').map(button => button.text())).toEqual([expect.stringContaining('SW-003')])

    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['DET-042']])
    expect(wrapper.emitted('seek')).toEqual([[2_200]])
  })

  it('keeps zero-duration replays readable and seeks a selected switch using its source time', async () => {
    const replay = { ...(fixtureSource.replay as Replay), durationS: 0, currentTimeS: 0 }
    const event = fixtureSource.events[1] as SwitchEvent
    const wrapper = mount(ReplayTimeline, { props: { replay, events: [event], selectedEventId: null } })

    expect(wrapper.get('.replay-timeline__progress').attributes('style')).toContain('width: 0%')
    expect(wrapper.get('.replay-timeline__marker').attributes('style')).toContain('left: 0%')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['SW-003']])
    expect(wrapper.emitted('seek')).toEqual([[2_518]])
  })
})
