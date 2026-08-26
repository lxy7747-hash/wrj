import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'http://127.0.0.1:5173'
const RUNTIME_ROOTS = ['server/index.ts', 'server/app.ts']

const FORBIDDEN_CAPABILITIES = [
  {
    name: 'host/storage/process modules',
    pattern: /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:fs(?:\/promises)?|child_process|crypto|dns|dgram|https|net|tls|sqlite3|better-sqlite3|uuid|axios|got|undici)['"]/,
  },
  { name: 'system time', pattern: /\b(?:Date|performance\.now|process\.hrtime)\b/ },
  { name: 'random or UUID generation', pattern: /\b(?:Math\.random|randomUUID|crypto\.getRandomValues|uuidv[1-9])\s*\(/ },
  { name: 'outbound network', pattern: /\b(?:fetch|XMLHttpRequest|EventSource|https?\.(?:get|request)|net\.connect|tls\.connect|dns\.(?:lookup|resolve)|new\s+WebSocket)\s*\(/ },
  { name: 'file writes', pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate|unlink|rename|mkdir|rm)\s*\(/ },
  { name: 'process execution', pattern: /\b(?:(?:childProcess|child_process)\.(?:exec|execFile|spawn|fork)|execFile|spawn|fork)\s*\(/ },
  { name: 'browser-generated artifacts', pattern: /\b(?:Blob|File|URL\.createObjectURL)\b/ },
  { name: 'runtime timers', pattern: /\b(?:setTimeout|setInterval|setImmediate)\s*\(/ },
] as const

interface RequestChain {
  set(name: string, value: string): RequestChain
  send(body: unknown): RequestChain
  expect(status: number): Promise<unknown>
}

type ReadTextFile = (path: URL, encoding: 'utf8') => Promise<string>

function runtimeImportSpecifiers(source: string): string[] {
  const staticImports = source.matchAll(
    /^\s*import\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]\s*;?/gm,
  )
  const reExports = source.matchAll(
    /^\s*export\s+(?!type\b)[^'";]*?\sfrom\s+['"]([^'"]+)['"]\s*;?/gm,
  )
  const dynamicImports = source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  const requires = source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  return [...staticImports, ...reExports, ...dynamicImports, ...requires]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined && specifier.startsWith('.'))
}

function sourceUrl(specifier: string, importer: URL): URL {
  const resolved = new URL(specifier, importer)
  if (resolved.pathname.endsWith('.js')) {
    resolved.pathname = `${resolved.pathname.slice(0, -3)}.ts`
  } else if (!/\.[A-Za-z0-9]+$/u.test(resolved.pathname)) {
    resolved.pathname = `${resolved.pathname}.ts`
  }
  return resolved
}

async function discoverRuntimeSources(
  readFile: ReadTextFile,
  workspaceRoot: URL,
): Promise<Map<string, string>> {
  const pending = RUNTIME_ROOTS.map((root) => new URL(root, workspaceRoot))
  const discovered = new Map<string, string>()

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || discovered.has(current.href)) {
      continue
    }
    if (current.protocol !== 'file:') {
      throw new Error(`Runtime import resolved outside the local file closure: ${current.href}`)
    }

    const source = await readFile(current, 'utf8')
    discovered.set(current.href, source)
    for (const specifier of runtimeImportSpecifiers(source)) {
      const imported = sourceUrl(specifier, current)
      if (!discovered.has(imported.href)) {
        pending.push(imported)
      }
    }
  }

  return discovered
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('P0 production runtime side-effect boundary', () => {
  it('does not import forbidden host, storage, process, or network clients', async () => {
    const fsModulePath = 'node:fs/' + 'promises'
    const processModulePath = 'node:' + 'process'
    const urlModulePath = 'node:' + 'url'
    const { readFile } = await import(fsModulePath) as {
      readFile(path: URL, encoding: 'utf8'): Promise<string>
    }
    const { cwd } = await import(processModulePath) as { cwd(): string }
    const { pathToFileURL } = await import(urlModulePath) as {
      pathToFileURL(path: string): URL
    }
    const workspaceRoot = pathToFileURL(cwd())
    if (!workspaceRoot.pathname.endsWith('/')) {
      workspaceRoot.pathname = `${workspaceRoot.pathname}/`
    }

    const sources = await discoverRuntimeSources(readFile, workspaceRoot)
    expect([...sources.keys()]).toEqual(expect.arrayContaining([
      expect.stringMatching(/\/server\/state\/projection\.ts$/),
      expect.stringMatching(/\/server\/fixtures\/source\.ts$/),
      expect.stringMatching(/\/deterministic-fixtures\.json$/),
    ]))
    const productionSource = [...sources.values()].join('\n')

    for (const capability of FORBIDDEN_CAPABILITIES) {
      expect(productionSource, capability.name).not.toMatch(capability.pattern)
    }
  })

  it('performs reset entirely in memory without outbound fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const appModulePath = '../../server/' + 'app.js'
    const supertestModulePath = 'super' + 'test'
    const { createMockServer } = await import(appModulePath) as {
      createMockServer(options?: { port?: number }): {
        httpServer: {
          listening: boolean
          once(event: string, listener: (...args: unknown[]) => void): unknown
          address(): { port: number } | string | null
        }
        close(): Promise<void>
      }
    }
    const { default: request } = await import(supertestModulePath) as {
      default(baseUrl: string): {
        post(path: string): RequestChain
      }
    }
    const server = createMockServer({ port: 0 })

    try {
      if (!server.httpServer.listening) {
        await new Promise<void>((resolve) => server.httpServer.once('listening', () => resolve()))
      }
      const address = server.httpServer.address()
      if (address === null || typeof address === 'string') {
        throw new Error('Expected a TCP listener address.')
      }

      await request(`http://127.0.0.1:${address.port}`)
        .post('/api/v1/reset')
        .set('Origin', ORIGIN)
        .set('X-Demo-Role', 'ADMIN')
        .send({ confirm: true })
        .expect(200)

      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })
})
