// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
const { mkdtemp, readFile, readdir, rm, stat, writeFile } = await import('node:' + 'fs/promises')
const { tmpdir } = await import('node:' + 'os')
const { join } = await import('node:' + 'path')
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  networkInterfaces: () => ({ Ethernet: [{ address: '192.168.1.9', family: 'IPv4' }] }),
}))
const { syncLocalLinkCalcConfig } = await import('../../server/local/' + 'link-calc-config.js')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(content = '#\xd6\xd0\xce\xc4\r\nwsip=192.168.1.14\r\nwsport=8080\r\nwspath=/ws/v1\r\nframe_rate=5\r\n') {
  const root = await mkdtemp(join(tmpdir(), 'wrj-calc-config-'))
  roots.push(root)
  const config = join(root, 'CalcConfig.ini'), executable = join(root, 'mission.exe')
  await writeFile(config, content, 'latin1')
  return { root, config, executable, content }
}

it.each(['127.0.0.1', 'localhost', '192.168.1.9'])('将本机 %s 的 IP/端口/路径同步到 exe 目录并保留其他字节', async host => {
  const f = await fixture()
  const address = `ws://${host}:9090/engine`
  expect(await syncLocalLinkCalcConfig(f.executable, address)).toBe(true)
  expect(await readFile(f.config, 'latin1')).toBe(f.content.replace('192.168.1.14', host === 'localhost' ? '127.0.0.1' : host).replace('8080', '9090').replace('/ws/v1', '/engine'))
  const before = await stat(f.config)
  expect(await syncLocalLinkCalcConfig(f.executable, address)).toBe(false)
  expect((await stat(f.config)).mtimeMs).toBe(before.mtimeMs)
  expect(await readdir(f.root)).toEqual(['CalcConfig.ini'])
})

it('保留 LF、空白和行尾注释，未指定端口时按 ws 默认 80 同步', async () => {
  const f = await fixture(' wsip = 192.168.1.14 # IP\nwsport=8080 ; port\nwspath=/ws/v1\nframe_rate=5')
  await syncLocalLinkCalcConfig(f.executable, 'ws://127.0.0.1')
  expect(await readFile(f.config, 'latin1')).toBe(' wsip = 127.0.0.1 # IP\nwsport=80 ; port\nwspath=/\nframe_rate=5')
})

it.each([undefined, 'ws://192.0.2.1:8080/ws/v1', 'wss://remote.example/ws', 'wss://127.0.0.1/ws'])('不改写关闭连接或远程/TLS 地址 %s 的本机配置', async address => {
  const f = await fixture()
  expect(await syncLocalLinkCalcConfig(f.executable, address)).toBe(false)
  expect(await readFile(f.config, 'latin1')).toBe(f.content)
})

it.each(['wsip=1\nwsport=8080\n', 'wsip=1\nwsip=2\nwsport=8080\nwspath=/ws'])('缺失或重复字段时报告配置路径并保持文件完整', async content => {
  const f = await fixture(content)
  await expect(syncLocalLinkCalcConfig(f.executable, 'ws://127.0.0.1:8080/ws/v1')).rejects.toThrow(f.config)
  expect(await readFile(f.config, 'latin1')).toBe(content)
  expect(await readdir(f.root)).toEqual(['CalcConfig.ini'])
})

it('缺少配置文件时明确失败，不创建不完整的插件配置', async () => {
  const f = await fixture()
  await rm(f.config)
  await expect(syncLocalLinkCalcConfig(f.executable, 'ws://127.0.0.1:8080/ws/v1')).rejects.toThrow(f.config)
  expect(await readdir(f.root)).toEqual([])
})

it.each(['ws://127.0.0.1/ws?token=x', 'ws://user:pass@127.0.0.1/ws', 'http://127.0.0.1/ws'])('拒绝不能写入插件的地址 %s，不改变文件', async address => {
  const f = await fixture()
  await expect(syncLocalLinkCalcConfig(f.executable, address)).rejects.toThrow()
  expect(await readFile(f.config, 'latin1')).toBe(f.content)
})
