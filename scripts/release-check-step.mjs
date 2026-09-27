import { spawn, execFileSync } from 'node:child_process'

function stopTree(child) {
  if (!child.pid) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    child.kill('SIGKILL')
  }
}

/** Return only after the step exits or its process tree has been stopped. */
export function runStep(command, args, options) {
  const { timeoutMs, signal, ...spawnOptions } = options
  return new Promise((resolve) => {
    let output = ''
    let reason
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stop = (why) => {
      if (reason) return
      reason = why
      output += `\n检查${why === 'timeout' ? '超时' : '中断'}，已终止子进程树。\n`
      stopTree(child)
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    const abort = () => stop('interrupted')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout?.on('data', chunk => { output += chunk })
    child.stderr?.on('data', chunk => { output += chunk })
    child.once('error', error => { output += `\n${error.message}` })
    child.once('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve({ exitCode: reason ? 1 : (code ?? 1), reason, output, pid: child.pid })
    })
  })
}
