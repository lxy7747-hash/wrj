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
    detached: process.platform !== 'win32',
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
    if (child.exitCode !== null || child.signalCode !== null) return
    if (!child.pid) { child.kill(); return }
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch { /* 进程组已经退出。 */ } }, 5_000)
      return
    }
    // Windows 上只结束 cmd 外壳会遗留本次 npm 启动的服务进程。
    const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    const timeout = setTimeout(() => { cleanup.kill(); child.kill() }, 5_000)
    cleanup.once('error', () => { clearTimeout(timeout); child.kill() })
    cleanup.once('exit', () => { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill() })
  })
}

children.forEach((child) => {
  child.once('error', (error) => {
    console.error(`开发服务启动失败：${error.message}`)
    stopAll(1)
  })
  child.once('exit', () => {
    if (!stopping) stopAll(1)
  })
})

process.once('SIGINT', () => stopAll(0))
process.once('SIGTERM', () => stopAll(0))
