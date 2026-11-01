import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessageBox, ElSelect } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RoleProfiles from '../../src/components/admin/RoleProfiles.vue'
import { APP_CONFIG } from '../../src/config/app.config'

const emptyConfig = () => ({ version: 1, profiles: [], assignments: [] })
const response = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400
  ? { ok: true, data }
  : { ok: false, error: { message: '角色配置服务暂不可用。' } }), { status, headers: { 'Content-Type': 'application/json' } })
const dialogStub = { props: ['modelValue', 'title'], template: '<section v-if="modelValue"><h4>{{ title }}</h4><slot/><slot name="footer"/></section>' }
const wrappers: VueWrapper[] = []
const showMasterData = APP_CONFIG.systemManagement.showMasterData

function setup(): VueWrapper {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(RoleProfiles, { props: { users: [] }, global: { plugins: [pinia, ElementPlus], stubs: { ElDialog: dialogStub } } })
  wrappers.push(wrapper)
  return wrapper
}

function button(wrapper: VueWrapper, text: string) {
  const result = wrapper.findAll('button').find(row => row.text() === text)
  if (!result) throw new Error(`找不到按钮：${text}`)
  return result
}

describe('部署地址下的角色权限配置', () => {
  afterEach(() => {
    wrappers.splice(0).forEach(wrapper => wrapper.unmount())
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    APP_CONFIG.systemManagement.showMasterData = showMasterData
  })

  it('内网页面从自身 origin 加载和保存，加载完空配置后允许新增并经确认保存', async () => {
    vi.stubEnv('MODE', 'lan')
    vi.stubEnv('VITE_MOCK_ORIGIN', 'http://127.0.0.1:4173')
    let resolveLoad!: (value: Response) => void
    const saved = { version: 2, profiles: [{ profileId: 'LAN-READ', name: '内网只读', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }], assignments: [] }
    const fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveLoad = resolve }))
      .mockResolvedValueOnce(response(saved))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)

    const wrapper = setup()
    await flushPromises()
    expect(button(wrapper, '新增角色').attributes('disabled')).toBeDefined()
    expect(fetch.mock.calls[0]?.[0]).toBe(`${window.location.origin}/api/v1/admin/access-control`)

    resolveLoad(response(emptyConfig()))
    await flushPromises()
    expect(button(wrapper, '新增角色').attributes('disabled')).toBeUndefined()
    await button(wrapper, '新增角色').trigger('click')
    await wrapper.get('[data-testid="profile-id"]').setValue('LAN-READ')
    await wrapper.get('[data-testid="profile-name"]').setValue('内网只读')
    await button(wrapper, '确认配置').trigger('click')
    expect(wrapper.text()).toContain('内网只读')

    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(ElMessageBox.confirm).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[1]?.[0]).toBe(`${window.location.origin}/api/v1/admin/access-control`)
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      profiles: [{ profileId: 'LAN-READ', name: '内网只读' }],
    })
  })

  it('加载失败时保持新增禁用和错误提示，重新加载成功后恢复可用', async () => {
    vi.stubEnv('MODE', 'lan')
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(undefined, 503))
      .mockResolvedValueOnce(response(emptyConfig()))
    vi.stubGlobal('fetch', fetch)

    const wrapper = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('角色配置服务暂不可用。')
    expect(button(wrapper, '新增角色').attributes('disabled')).toBeDefined()

    await button(wrapper, '重新加载').trigger('click')
    await flushPromises()
    expect(fetch.mock.calls[1]?.[0]).toBe(`${window.location.origin}/api/v1/admin/access-control`)
    expect(button(wrapper, '新增角色').attributes('disabled')).toBeUndefined()
  })

  it('读取已退休的空菜单操作员角色，但必须补回菜单后才能保存', async () => {
    const retired = {
      version: 1,
      profiles: [{ profileId: 'RETIRED', name: '已退休角色', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: [] }],
      assignments: [],
    }
    const saved = { ...retired, version: 2, profiles: [{ ...retired.profiles[0], menuPaths: ['/situation'] }] }
    const fetch = vi.fn().mockResolvedValueOnce(response(retired)).mockResolvedValueOnce(response(saved))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)

    const wrapper = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('已退休角色')
    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('请为每个角色至少保留一个当前可用菜单后再保存。')
    expect(fetch).toHaveBeenCalledTimes(1)

    await button(wrapper, '编辑').trigger('click')
    const firstMenu = wrapper.get('[aria-label="菜单权限"] input')
    await firstMenu.setValue(true)
    await button(wrapper, '确认配置').trigger('click')
    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'RETIRED', menuPaths: ['/situation'] })],
    })
  })

  it('拒绝形状正确但包含未知权限的角色配置', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      version: 1,
      profiles: [{ profileId: 'BAD', name: '错误配置', baseRole: 'OPERATOR', permissions: ['UNKNOWN_PERMISSION'], menuPaths: ['/situation'] }],
      assignments: [],
    })))

    const wrapper = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('角色配置响应不正确。')
    expect(button(wrapper, '新增角色').attributes('disabled')).toBeDefined()
  })

  it('保存失败保留已读取的有效角色，以便用户修正后重试', async () => {
    const config = {
      version: 1,
      profiles: [{ profileId: 'OP', name: '操作员', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] }],
      assignments: [],
    }
    const fetch = vi.fn().mockResolvedValueOnce(response(config)).mockResolvedValueOnce(response(undefined, 503))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)

    const wrapper = setup()
    await flushPromises()
    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('角色配置服务暂不可用。')
    expect(wrapper.text()).toContain('操作员')
    expect(button(wrapper, '新增角色').attributes('disabled')).toBeUndefined()
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' })
  })

  it('保留两个旧基础数据菜单键，以合并后的分类名称加载、编辑和保存', async () => {
    const profile = {
      profileId: 'MASTER-DATA', name: '基础数据管理员', baseRole: 'ADMIN',
      permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'],
      menuPaths: ['/admin', '/admin?section=equipment-library', '/admin?section=master-data'],
    }
    const fetch = vi.fn().mockResolvedValueOnce(response({ version: 1, profiles: [profile], assignments: [] }))
      .mockImplementationOnce((_url, init) => Promise.resolve(response({ ...JSON.parse(String(init.body)), version: 2 })))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)

    const wrapper = setup()
    await flushPromises()
    expect(wrapper.text()).toContain('基础数据管理（设备参数）')
    expect(wrapper.text()).toContain('基础数据管理（通用基础数据）')
    await button(wrapper, '编辑').trigger('click')
    const editor = wrapper.findAll('section').find(section => section.text().includes('编辑自定义角色'))
    expect(editor?.text()).toContain('基础数据管理（设备参数）')
    expect(editor?.text()).toContain('基础数据管理（通用基础数据）')
    await button(wrapper, '确认配置').trigger('click')
    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      profiles: [expect.objectContaining({ menuPaths: profile.menuPaths })],
    })
  })

  it('全局隐藏基础数据时，角色编辑器同时隐藏两个旧基础数据菜单分类', async () => {
    APP_CONFIG.systemManagement.showMasterData = false
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      version: 1,
      profiles: [{ profileId: 'MASTER-DATA', name: '基础数据管理员', baseRole: 'ADMIN', permissions: ['BUSINESS_READ', 'USER_ROLE_MAINTAIN'], menuPaths: ['/admin'] }],
      assignments: [],
    })))

    const wrapper = setup()
    await flushPromises()
    await button(wrapper, '编辑').trigger('click')
    const editor = wrapper.findAll('section').find(section => section.text().includes('编辑自定义角色'))
    expect(editor?.text()).not.toContain('基础数据管理（设备参数）')
    expect(editor?.text()).not.toContain('基础数据管理（通用基础数据）')
  })

  it('退休角色的账号可重新分配到保留角色；取消确认不写入，确认后只保存新分配', async () => {
    const config = {
      version: 1,
      profiles: [
        { profileId: 'RETIRED', name: '旧批次角色', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: [] },
        { profileId: 'READ', name: '只读态势', baseRole: 'OPERATOR', permissions: ['BUSINESS_READ'], menuPaths: ['/situation'] },
      ],
      assignments: [{ userId: 'USER-1', profileId: 'RETIRED' }],
    }
    const fetch = vi.fn().mockResolvedValueOnce(response(config)).mockImplementationOnce((_url, init) => Promise.resolve(response({ ...JSON.parse(String(init.body)), version: 2 })))
    vi.stubGlobal('fetch', fetch)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel')
      .mockResolvedValueOnce('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
    const wrapper = setup()
    await wrapper.setProps({ users: [{ userId: 'USER-1', username: 'operator', role: 'OPERATOR', status: 'ACTIVE' }] })
    await flushPromises()
    expect(button(wrapper, '删除').attributes('disabled')).toBeDefined()
    wrapper.getComponent(ElSelect).vm.$emit('update:modelValue', 'READ')
    await flushPromises()
    await button(wrapper, '删除').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('旧批次角色')
    expect(wrapper.text()).toContain('只读态势')
    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(1)
    await button(wrapper, '保存权限配置').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      profiles: [expect.objectContaining({ profileId: 'READ' })],
      assignments: [{ userId: 'USER-1', profileId: 'READ' }],
    })
  })
})
