import { readFileSync } from 'node:fs'

// 两个模拟入口共用这一份录制文件；日志前缀时间不参与仿真计时。
export function readMockFrames(file = new URL('./frame_snap.txt', import.meta.url)) {
  const bytes = readFileSync(file)
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8'
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  const frames = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    try {
      const json = line.trim().replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\s*/, '')
      const frame = JSON.parse(json)
      if (!frame || Array.isArray(frame) || frame.msg_type !== 'frame_snapshot'
        || !Number.isSafeInteger(frame.frame_id) || frame.frame_id < 0 || !Array.isArray(frame.link_calc?.links)) {
        throw new Error('需要 frame_snapshot、非负整数 frame_id 和 link_calc.links 数组')
      }
      if (frames.length && frame.frame_id <= frames.at(-1).frame_id) throw new Error('帧号必须按文件顺序递增')
      frames.push(frame)
    } catch (error) { throw new Error(`模拟数据 ${String(file)} 第 ${index + 1} 行无效：${error.message}`) }
  }
  if (!frames.length) throw new Error(`模拟数据 ${String(file)} 没有可推送的帧`)
  return frames
}
