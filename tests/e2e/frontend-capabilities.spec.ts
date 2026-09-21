import { expect, test } from '@playwright/test'

const origin = 'http://127.0.0.1:4173'
const headers = { Origin: 'http://127.0.0.1:5173', 'X-Demo-Role': 'ADMIN' }

test('补齐能力：装备完整参数、版本查看与角色表单可用，无测量不造值', async ({ page, request }) => {
  await request.post(`${origin}/api/v1/reset`, { headers })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/login')
  await page.getByTestId('login-username').fill('admin')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.goto('/admin?section=equipment-library')
  await expect(page.getByTestId('equipment-table')).toContainText('暂无数据')
  await page.getByTestId('equipment-create').click()
  await page.getByTestId('equipment-id').fill('BROWSER-EQ')
  await page.getByTestId('equipment-type').fill('浏览器测试装备')
  await page.getByTestId('equipment-bandwidth').locator('input').fill('2')
  await page.getByTestId('equipment-power').locator('input').fill('0')
  await page.getByTestId('equipment-data-rate').locator('input').fill('5')
  await page.getByTestId('equipment-save').click()
  await expect(page.getByTestId('equipment-table')).toContainText('BROWSER-EQ')
  await page.reload()
  await expect(page.getByTestId('equipment-table')).toContainText('浏览器测试装备')
  await page.getByTestId('equipment-table').getByRole('button', { name: '查看', exact: true }).click()
  const detail = page.getByRole('dialog', { name: '查看参数详情' })
  await expect(detail).toContainText('带宽（MHz）')
  await expect(detail.getByTestId('equipment-relations')).toContainText('版本历史')
  await expect(detail.getByTestId('equipment-relations')).toContainText('浏览器测试装备')
  await expect(detail.getByTestId('equipment-relations')).toContainText('暂无数据')
  await detail.getByRole('button', { name: '关闭', exact: true }).click()
  await page.goto('/admin')
  await page.getByRole('button', { name: '角色权限配置', exact: true }).click()
  const roles = page.getByTestId('role-profiles')
  await expect(roles).toContainText('未分配自定义角色的账号保持原有权限')
  await roles.getByRole('button', { name: '新增角色', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '新增自定义角色' })
  await editor.getByTestId('profile-id').fill('BROWSER-READ')
  await editor.getByTestId('profile-name').fill('浏览器只读角色')
  await editor.getByRole('button', { name: '确认配置', exact: true }).click()
  await roles.getByRole('button', { name: '保存权限配置', exact: true }).click()
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.getByText('角色配置已保存，受影响账号需重新登录。', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '角色权限配置', exact: true }).click()
  await expect(page.getByTestId('role-profiles')).toContainText('浏览器只读角色')
  // 只清理本用例创建的角色，纯 Mock 的配置不作为真实数据。
  const config = (await (await request.get(`${origin}/api/v1/admin/access-control`, { headers })).json()).data
  await request.put(`${origin}/api/v1/admin/access-control`, { headers, data: { ...config, profiles: config.profiles.filter((row: { profileId: string }) => row.profileId !== 'BROWSER-READ') } })
  expect(errors).toEqual([])
})

test('补齐能力：质量报告图表与时间筛选在双视口可达', async ({ page, request }) => {
  await request.post(`${origin}/api/v1/reset`, { headers })
  await page.goto('/login')
  await page.getByTestId('login-username').fill('operator')
  await page.getByTestId('login-password').fill('123456')
  await page.getByTestId('login-submit').click()
  await page.waitForURL('**/situation')
  await page.goto('/reports')
  await expect(page.getByTestId('report-tabs')).toBeVisible()
  for (const name of ['柱状图', '雷达图', '事件时间线']) {
    await page.getByRole('tab', { name, exact: true }).click()
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
  }
  await expect(page.getByLabel('质量报告筛选')).toBeVisible()
})
