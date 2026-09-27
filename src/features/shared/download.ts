/** 只下载通过认证 API 返回的附件，不接受服务端磁盘路径或外部 URL。 */
export async function saveDownload(response: Response, filename: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error?.message ?? '下载失败，请重试。')
  }
  if (!response.headers.get('Content-Disposition')?.startsWith('attachment;')) throw new Error('服务端未返回下载附件。')
  const blob = await response.blob()
  if (!isCurrent()) return false
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  // 留给浏览器启动读取；立即回收在部分浏览器中会取消下载。
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}
