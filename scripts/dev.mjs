import { spawn } from 'node:child_process'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
let stopping = false

/**
 * 启动指定的 npm 开发脚本，并将输入输出连接到当前终端。
 * @param {string} scriptName package.json 中的脚本名称。
 * @returns {import('node:child_process').ChildProcess} 已启动的子进程。
 */
function startScript(scriptName) {
  return spawn(npmCommand, ['run', scriptName], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

const children = [startScript('dev:mock'), startScript('dev:ui')]

/**
 * 停止本次启动的两个开发服务，并设置聚合命令的退出码。
 * @param {number} exitCode 聚合命令退出码，0 表示正常退出。
 */
function stopAll(exitCode) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  children.forEach((child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
}

children.forEach((child) => {
  child.once('error', (error) => {
    console.error(`开发服务启动失败：${error.message}`)
    stopAll(1)
  })
  child.once('exit', (code) => {
    if (!stopping) stopAll(code ?? 1)
  })
})

process.once('SIGINT', () => stopAll(0))
process.once('SIGTERM', () => stopAll(0))
