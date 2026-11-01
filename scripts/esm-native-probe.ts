import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const executable = resolve(process.argv[2] ?? 'H:/Project/newWrj/Release/Release/mission.exe')
const root = resolve('output', `functional-esm-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
const input = [
  'radar_signature PROBE_SIG', '  constant 10 m^2', 'end_radar_signature',
  'platform_type ESM_LISTENER WSF_PLATFORM',
  '  sensor esm WSF_ESM_SENSOR',
  '    mode default', '      frame_time 1 sec',
  '      frequency_band 2 GHz 4 GHz', '      dwell_time 1 sec', '      revisit_time 1 sec',
  '      continuous_detection_sensitivity -200 dBW', '      pulsed_detection_sensitivity -200 dBW', '      detection_threshold 0 dB',
  '    end_mode', '    on', '  end_sensor', 'end_platform_type',
  'platform_type EMITTER WSF_PLATFORM', '  radar_signature PROBE_SIG',
  '  sensor radar WSF_RADAR_SENSOR', '    mode default', '      frame_time 1 sec', '      beam 1',
  '        azimuth_field_of_view -180 deg 180 deg', '        elevation_field_of_view -90 deg 90 deg',
  '        minimum_range 1 m', '        maximum_range 100 km',
  '        transmitter', '          frequency 3 GHz', '          power 1000 W', '          pulse_width 1 us', '          pulse_repetition_frequency 1000 Hz', '        end_transmitter',
  '        receiver', '          noise_figure 3 dB', '          bandwidth 1 MHz', '        end_receiver',
  '      end_beam', '    end_mode', '    on', '  end_sensor', 'end_platform_type',
  'platform listener ESM_LISTENER', '  position 25n 121e', '  altitude 1000 m', 'end_platform',
  'platform emitter EMITTER', '  position 25n 121.001e', '  altitude 1000 m', 'end_platform',
  'platform target EMITTER', '  position 25n 121.01e', '  altitude 1000 m', 'end_platform',
  'start_time 00:00:00', 'end_time 3 sec',
  'csv_event_output', `  file "${join(root, 'events.csv').replace(/\\/g, '/')}"`,
  '  enable SENSOR_DETECTION_CHANGED', '  enable SENSOR_TRACK_INITIATED', '  enable SENSOR_TRACK_UPDATED', '  enable SIMULATION_COMPLETE', 'end_csv_event_output', '',
].join('\n')

await mkdir(root, { recursive: true })
const inputPath = join(root, 'probe.txt')
await writeFile(inputPath, input, 'utf8')
const result = await new Promise<{ code: number | null; output: string }>((resolveRun, reject) => {
  const child = spawn(executable, ['-es', 'probe.txt'], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', value => { output += value })
  child.stderr.setEncoding('utf8').on('data', value => { output += value })
  child.once('error', reject)
  child.once('close', code => resolveRun({ code, output }))
})
await writeFile(join(root, 'mission-console.log'), result.output, 'utf8')
console.log(JSON.stringify({ root, ...result }))
