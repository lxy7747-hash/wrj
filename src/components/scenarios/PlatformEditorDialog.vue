<script setup lang="ts">
import { computed, ref, toRaw, watch } from 'vue'
import type { BusinessInformationNodeType, Faction, Platform, PlatformType, SatelliteType, TemplateRoutePoint, ValidationIssue, Waypoint } from '../../contracts/domain-models'
import { INFORMATION_NODE_LIMIT, PLATFORM_TYPE_DOMAINS, WAYPOINT_PLATFORM_TYPES, waypointSpeedError } from '../../features/scenarios/scenario-validation'
import { createPlatformGrid } from '../../features/scenarios/platform-layout'
import { PLATFORM_POINT_DEFAULT_ALTITUDE, PLATFORM_POINT_DEFAULT_SPEED, PLATFORM_POSITION_RULES, RELAY_DEFAULT_ORIGIN, RELAY_DEFAULT_ROUTE, SATELLITE_GEO_POSITION } from '../../features/scenarios/platform-position-rules'
import { fieldValidationMessage } from '../../features/scenarios/validation-fields'
import WaypointMapPicker, { type WaypointMapContext, type WaypointMapNode, type WaypointMapPoint, type WaypointMapRoute } from './WaypointMapPicker.vue'

type PlatformTypeOption = { value: PlatformType, label: string }
type SatelliteTypeOption = { value: SatelliteType, label: string }
/** 新模板路线：盘旋航点与返航路线。 */
type TemplateRouteList = 'loiter' | 'return'
type AppendRouteList = 'waypoints' | 'loiter'
/** index 为 null 时，地图选择多个新点并追加到路线。 */
type RoutePickerTarget =
  | { list: 'waypoints' | TemplateRouteList, index: number }
  | { list: AppendRouteList, index: null }
  | { list: 'initialPosition' }

/** 可配置盘旋航点的平台类型，与场景校验保持一致。 */
const LOITER_PLATFORM_TYPES: readonly PlatformType[] = ['AIRBORNE_MISSION_CLUSTER', 'FORWARD_RELAY_NODE', 'AIRBORNE_JAMMER_PLATFORM']
/** 可配置返航的平台类型（无人机类），与场景校验保持一致。 */
const RETURN_PLATFORM_TYPES: readonly PlatformType[] = ['AIRBORNE_MISSION_CLUSTER', 'FORWARD_RELAY_NODE']
/** 新模板路线点列表在平台对象中的字段路径，用于原位显示校验错误。 */
const TEMPLATE_ROUTE_FIELDS: Record<TemplateRouteList, string> = { loiter: 'loiterWaypoints', return: 'returnPlan.waypoints' }
const TEMPLATE_ROUTE_SPEED_ERROR = '速度必须至少为 1 m/s。'
const RETURN_TIME_ERROR = '返航时刻必须大于 0 且早于仿真结束时刻。'

const props = defineProps<{
  modelValue: boolean
  platform: Platform | null
  existingNodes?: readonly WaypointMapNode[]
  editing: boolean
  showIds?: boolean
  error: string
  pending: boolean
  locked: boolean
  businessTypeOptions: readonly PlatformTypeOption[]
  supportingTypeOptions: readonly PlatformTypeOption[]
  satelliteTypeOptions: readonly SatelliteTypeOption[]
  businessTypeCounts: Readonly<Record<BusinessInformationNodeType, number>>
  businessTypeLimits: Readonly<Record<BusinessInformationNodeType, number>>
  deploymentDomainLabels: Record<Platform['category'], string>
  suggestPlatformId?: (type: PlatformType) => string
  validate?: (platform: Platform) => ValidationIssue[]
  businessNodeCount?: number
}>()

const DEFAULT_TYPE_NAMES: Record<PlatformType, string> = {
  REAR_COMMAND_NODE: '后方指挥节点',
  FORWARD_RELAY_NODE: '高空前出中继节点',
  GROUND_CLUSTER_COMMAND_NODE: '地面无人集群指挥车',
  AIRBORNE_MISSION_CLUSTER: '空中无人作业集群',
  COMMUNICATION_SATELLITE: '天通卫星',
  GROUND_JAMMER_DETECTION_STATION: '地面干扰设备',
  AIRBORNE_JAMMER_PLATFORM: '机载干扰设备',
}

const emit = defineEmits<{
  'update:modelValue': [visible: boolean]
  apply: [platform: Platform, quantity: number, spacingKm: number]
  invalid: [message: string]
}>()

const editor = ref<Platform | null>(null)
const advancedConfig = ref<HTMLDetailsElement | null>(null)
const waypointPickerVisible = ref(false)
const waypointPickerTarget = ref<RoutePickerTarget | null>(null)
const waypointPickerPoint = ref<WaypointMapPoint>({ longitude: 0, latitude: 0 })
const quantity = ref(1)
const spacingKm = ref(1)
const confirmationAttempted = ref(false)
const touchedFields = ref<ReadonlySet<string>>(new Set())

const selectedBusinessType = computed(() => {
  const type = editor.value?.type
  return type !== undefined && Object.hasOwn(props.businessTypeLimits, type)
    ? type as BusinessInformationNodeType
    : null
})
const availableQuantity = computed(() => {
  const type = selectedBusinessType.value
  if (type === null) return 1
  const editingCurrentType = props.editing && props.platform?.type === type ? 1 : 0
  const typeRemaining = Math.max(0, props.businessTypeLimits[type] - props.businessTypeCounts[type] + editingCurrentType)
  const totalCurrent = props.businessNodeCount ?? Object.values(props.businessTypeCounts).reduce((a, b) => a + b, 0)
  const totalRemaining = Math.max(0, INFORMATION_NODE_LIMIT - totalCurrent + editingCurrentType)
  return Math.min(typeRemaining, totalRemaining)
})
const showBatchQuantity = computed(() => !props.editing && editor.value?.type === 'AIRBORNE_MISSION_CLUSTER')
const showGridSpacing = computed(() => showBatchQuantity.value && quantity.value > 1 && editor.value?.waypoints.length === 0)
const invalidSpacing = computed(() => showGridSpacing.value && (!Number.isFinite(spacingKm.value) || spacingKm.value <= 0))
const cannotAdd = computed(() => !props.editing && availableQuantity.value === 0)
const positionRule = computed(() => editor.value ? PLATFORM_POSITION_RULES[editor.value.type] : undefined)
const waypointBounds = computed(() => supportsWaypoints.value ? positionRule.value : undefined)
const isSatellite = computed(() => editor.value?.type === 'COMMUNICATION_SATELLITE')
const initialPositionLabel = computed(() => editor.value?.type === 'AIRBORNE_MISSION_CLUSTER' ? '编队原点' : '初始位置')
/** 任务无人机与前出中继可配置普通航点。 */
const supportsWaypoints = computed(() => editor.value !== null && (WAYPOINT_PLATFORM_TYPES as readonly PlatformType[]).includes(editor.value.type))
const supportsInitialPositionPicker = computed(() => editor.value !== null && !isSatellite.value)
const hasInvalidWaypointSpeed = computed(() => supportsWaypoints.value && editor.value?.waypoints.some(point => waypointSpeedError(point.speed)) === true)
const invalidSatelliteType = computed(() => editor.value?.type === 'COMMUNICATION_SATELLITE'
  && editor.value.satelliteType !== 'TIANTONG' && editor.value.satelliteType !== 'SHENTONG')
/** 平台阵营选项：显式选择后写入；清空表示按平台类型推断，不自动回写旧数据。 */
const FACTION_OPTIONS: readonly { value: Faction; label: string }[] = [
  { value: 'BLUE', label: '蓝方' },
  { value: 'RED', label: '红方' },
  { value: 'NEUTRAL', label: '中立' },
]
function setFaction(value: Faction | '' | undefined): void {
  if (editor.value === null) return
  touchField('faction')
  if (value === 'BLUE' || value === 'RED' || value === 'NEUTRAL') editor.value.faction = value
  else delete editor.value.faction
}
/** 节点通信范围界面按 km 编辑、合同存 m；清空表示未配置。 */
const communicationRangeKm = computed<number | undefined>({
  get: () => editor.value?.communicationRangeM === undefined ? undefined : Number((editor.value.communicationRangeM / 1000).toFixed(3)),
  set: (value) => {
    if (editor.value === null) return
    touchField('communicationRangeM')
    if (value === undefined || value === null || !Number.isFinite(value)) delete editor.value.communicationRangeM
    else editor.value.communicationRangeM = value * 1000
  },
})
function setCommunicationRangeKm(value: number | undefined): void {
  communicationRangeKm.value = value ?? undefined
}
const batchAdding = computed(() => showBatchQuantity.value && quantity.value > 1)
const supportsLoiter = computed(() => editor.value !== null && LOITER_PLATFORM_TYPES.includes(editor.value.type))
const supportsReturn = computed(() => editor.value !== null && RETURN_PLATFORM_TYPES.includes(editor.value.type))
const visibleTemplateRoutes = computed<TemplateRouteList[]>(() => [
  ...(supportsLoiter.value ? ['loiter' as const] : []), ...(supportsReturn.value ? ['return' as const] : []),
])
/** 普通航点沿用类型选点范围；新模板路线点不受编队范围限制，与校验一致。 */
const waypointPickerBounds = computed(() => {
  const target = waypointPickerTarget.value
  if (target === null || target.list === 'waypoints') return waypointBounds.value
  // 初始位置选点与经纬度输入使用相同的节点类型范围。
  if (target.list === 'initialPosition') return positionRule.value
  return undefined
})
/** 当前是否在为初始位置打开地图选点，用于切换弹窗文案。 */
const pickingInitialPosition = computed(() => waypointPickerTarget.value?.list === 'initialPosition')
const pickingReturnWaypoint = computed(() => waypointPickerTarget.value?.list === 'return')
const waypointPickerRoute = computed<WaypointMapRoute | undefined>(() => {
  const platform = editor.value
  const target = waypointPickerTarget.value
  if (!platform || !target || target.list === 'initialPosition' || target.index !== null) return
  const loiter = target.list === 'loiter'
  const points = loiter ? platform.loiterWaypoints ?? [] : platform.waypoints
  const origin = (loiter && supportsWaypoints.value ? platform.waypoints.at(-1) : undefined) ?? platform.initialPosition
  return { points, origin, loiter, altitude: PLATFORM_POINT_DEFAULT_ALTITUDE }
})
/** 单点编辑航点/盘旋点/返航点时，展示整条路线的已有航点与连线。 */
const waypointPickerContext = computed<WaypointMapContext | undefined>(() => {
  const platform = editor.value
  const target = waypointPickerTarget.value
  if (!platform || !target || target.list === 'initialPosition' || target.index === null) return undefined
  const lastWaypoint = platform.waypoints.at(-1)
  if (target.list === 'waypoints') {
    return { points: platform.waypoints, origin: platform.initialPosition, loiter: false, activeIndex: target.index }
  }
  if (target.list === 'loiter') {
    return { points: platform.loiterWaypoints ?? [], origin: lastWaypoint ?? platform.initialPosition, loiter: true, activeIndex: target.index }
  }
  return {
    points: platform.returnPlan?.waypoints ?? [],
    origin: platform.loiterWaypoints?.at(-1) ?? lastWaypoint ?? platform.initialPosition,
    loiter: false, activeIndex: target.index,
  }
})
/** 盘旋 / 返航的本地兜底校验，仅在未传入 validate 或其尚未覆盖时阻止确认。 */
const templateRouteMessage = computed(() => {
  if (editor.value === null) return ''
  const loiter = editor.value.loiterWaypoints
  if (supportsLoiter.value && loiter !== undefined) {
    if (loiter.length < 2) return '盘旋航点至少需要 2 个。'
    if (loiter.some(point => waypointSpeedError(point.speed))) return `盘旋航点${TEMPLATE_ROUTE_SPEED_ERROR}`
  }
  const plan = editor.value.returnPlan
  if (supportsReturn.value && plan !== undefined) {
    if (!returnTimeValid(plan.timeS)) return RETURN_TIME_ERROR
    if (plan.waypoints.length === 0) return '返航路线至少需要 1 个航点。'
    if (plan.waypoints.some(point => waypointSpeedError(point.speed))) return `返航路线航点${TEMPLATE_ROUTE_SPEED_ERROR}`
  }
  return ''
})
/**
 * 生成提交副本：去掉当前类型不适用的普通航点、盘旋航点和返航路线。
 * 编辑中的内容本身不删，切错类型后再切回来仍可恢复；只有确认时提交的副本不带这些字段。
 * @param platform 编辑中的平台。
 */
function submission(platform: Platform): Platform {
  const result = structuredClone(toRaw(platform))
  if (!supportsWaypoints.value) result.waypoints = []
  // 卫星位置不在界面编辑，统一写 GEO 定点，与脚本和态势显示一致。
  if (result.type === 'COMMUNICATION_SATELLITE') result.initialPosition = { ...SATELLITE_GEO_POSITION }
  if (!supportsLoiter.value) delete result.loiterWaypoints
  if (!supportsReturn.value) delete result.returnPlan
  return result
}
const validationTick = ref(0)
watch(editor, () => { validationTick.value += 1 }, { deep: true, flush: 'sync' })
const validationIssues = computed(() => {
  void validationTick.value
  // 按提交副本校验，隐藏区域里保留的数据不产生错误。
  if (editor.value === null || props.validate === undefined) return []
  const platform = submission(editor.value)
  const issues = props.validate(platform)
  const loiterEntry = platform.loiterWaypoints?.[0]
  if (!showGridSpacing.value || !loiterEntry || invalidSpacing.value) return issues

  // 平铺后用实际节点的起点判断盘旋首点重合，编队原点可能没有节点。
  let gridPositions: Platform['initialPosition'][]
  try {
    gridPositions = createPlatformGrid(platform.initialPosition, quantity.value, spacingKm.value)
  } catch {
    return issues
  }
  const matchingStart = gridPositions.find(position => position.longitude === loiterEntry.longitude
    && position.latitude === loiterEntry.latitude && position.altitude === loiterEntry.altitude)
  if (!matchingStart) return issues.filter(issue => issue.code !== 'LOITER_ENTRY_COINCIDENT')
  if (issues.some(issue => issue.code === 'LOITER_ENTRY_COINCIDENT')) return issues
  const matchingIssue = props.validate({ ...platform, initialPosition: matchingStart }).find(issue => issue.code === 'LOITER_ENTRY_COINCIDENT')
  return matchingIssue ? [...issues, matchingIssue] : issues
})

/** 场景时长由父组件校验；本地只判断时刻为正的有限数。 */
function returnTimeValid(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function resetValidationState(): void {
  confirmationAttempted.value = false
  touchedFields.value = new Set()
}

function touchField(fieldPath: string): void {
  if (touchedFields.value.has(fieldPath)) return
  touchedFields.value = new Set([...touchedFields.value, fieldPath])
}

function shouldShowFieldError(fieldPath: string): boolean {
  if (confirmationAttempted.value) return true
  return [...touchedFields.value].some(touched => fieldPath === touched
    || fieldPath.startsWith(`${touched}.`) || fieldPath.startsWith(`${touched}[`)
    || touched.startsWith(`${fieldPath}.`) || touched.startsWith(`${fieldPath}[`))
}

function fieldError(fieldPath: string, fallback = ''): string {
  if ((fieldPath.startsWith('loiterWaypoints[') || fieldPath.startsWith('returnPlan.'))
    && !shouldShowFieldError(fieldPath)) return ''
  const validationMessage = fieldValidationMessage(validationIssues.value, fieldPath)
  if (validationMessage) return validationMessage
  return shouldShowFieldError(fieldPath) ? fallback : ''
}

/**
 * 只取列表本身的错误（如点数不足），避免与表格行内的字段错误重复显示。
 * @param fieldPath 列表字段路径，如 `loiterWaypoints`。
 * @param fallback 未传入校验函数时的本地兜底提示。
 */
function listFieldError(fieldPath: string, fallback = ''): string {
  // 点数等整条路线约束等确认时再显示，避免用户尚未填完就报错。
  if (!confirmationAttempted.value) return ''
  const ownIssues = validationIssues.value.filter(issue => issue.fieldPath === fieldPath)
  const validationMessage = fieldValidationMessage(ownIssues, fieldPath)
  if (validationMessage) return validationMessage
  return shouldShowFieldError(fieldPath) ? fallback : ''
}

function templateRouteListError(list: TemplateRouteList): string {
  if (editor.value === null) return ''
  if (list === 'loiter') {
    const count = editor.value.loiterWaypoints?.length
    return listFieldError('loiterWaypoints', count !== undefined && count < 2 ? '盘旋航点至少需要 2 个。' : '')
  }
  if (editor.value.returnPlan === undefined) return ''
  return listFieldError('returnPlan.waypoints', editor.value.returnPlan.waypoints.length === 0 ? '返航路线至少需要 1 个航点。' : '')
    || listFieldError('returnPlan')
}

/** 读取盘旋或返航的路线点；未配置时返回 `undefined`。 */
function templatePoints(list: TemplateRouteList): TemplateRoutePoint[] | undefined {
  return list === 'loiter' ? editor.value?.loiterWaypoints : editor.value?.returnPlan?.waypoints
}

/** 返航按原流程新增单行，坐标沿用末点或初始位置。 */
function addReturnWaypoint(): void {
  const platform = editor.value
  if (!platform?.returnPlan) return
  const points = platform.returnPlan.waypoints
  const base = points.at(-1) ?? platform.initialPosition
  points.push({ longitude: base.longitude, latitude: base.latitude, altitude: PLATFORM_POINT_DEFAULT_ALTITUDE, speed: PLATFORM_POINT_DEFAULT_SPEED })
}

/** 删除路线点；盘旋航点删空时移除字段，表示不盘旋。 */
function removeTemplatePoint(list: TemplateRouteList, index: number): void {
  const points = templatePoints(list)
  if (editor.value === null || points === undefined) return
  points.splice(index, 1)
  if (list === 'loiter' && points.length === 0) delete editor.value.loiterWaypoints
}

/** 将路线点与相邻点交换位置，越界时不处理。 */
function moveTemplatePoint(list: TemplateRouteList, index: number, offset: -1 | 1): void {
  const points = templatePoints(list)
  const target = index + offset
  if (points === undefined || target < 0 || target >= points.length) return
  const [point] = points.splice(index, 1)
  points.splice(target, 0, point!)
}

/**
 * 开关返航计划。
 * @param enabled 开关状态。
 * @sideEffects 关闭时删除 `returnPlan` 字段；打开时返航时刻留空待填写（由校验原位提示），航点为空列表。
 */
function toggleReturnPlan(enabled: string | number | boolean): void {
  if (editor.value === null) return
  if (!enabled) {
    delete editor.value.returnPlan
    return
  }
  if (editor.value.returnPlan !== undefined) return
  // 时刻不预填，避免把不合法或无依据的值当作用户配置；输入框保持空白待填写。
  editor.value.returnPlan = { timeS: undefined as unknown as number, waypoints: [] }
}

/**
 * 同步节点类型对应的卫星子类型和批量数量字段。
 * @param type 当前选择的节点类型。
 * @returns 无返回值。
 * @sideEffects 同步部署域、移除非卫星的子类型；不补卫星默认值，非空中无人作业集群恢复单条新增。
 */
function synchronizeTypeFields(type: PlatformType): void {
  if (editor.value === null) return
  resetMapPickers()
  resetValidationState()
  editor.value.category = PLATFORM_TYPE_DOMAINS[type]
  if (type !== 'COMMUNICATION_SATELLITE') delete editor.value.satelliteType
  // 不适用的普通航点、盘旋航点和返航路线只隐藏，确认时由 submission 去掉。
  if (type !== 'AIRBORNE_MISSION_CLUSTER') quantity.value = 1
  if (!props.editing) {
    if (props.suggestPlatformId && (!editor.value.id || /^(PLAT|SUP)-\d+$/.test(editor.value.id.trim()))) {
      editor.value.id = props.suggestPlatformId(type)
    }
    const currentName = editor.value.name ? editor.value.name.trim() : ''
    const isDefaultName = !currentName || Object.values(DEFAULT_TYPE_NAMES).includes(currentName) || currentName === '神通卫星' || currentName === '地面固定式干扰侦测站' || currentName === '机载干扰平台'
    if (isDefaultName) {
      if (type === 'COMMUNICATION_SATELLITE') {
        editor.value.name = editor.value.satelliteType === 'SHENTONG' ? '神通卫星' : '天通卫星'
      } else {
        editor.value.name = DEFAULT_TYPE_NAMES[type]
      }
    }
  }
}

function onPlatformTypeChange(type: PlatformType): void {
  // 只在新增时主动选择中继填入模板起飞点、中继点和盘旋点；已有航线内容不覆盖，打开已有节点不改写。
  if (!props.editing && type === 'FORWARD_RELAY_NODE' && editor.value) {
    editor.value.initialPosition = { ...RELAY_DEFAULT_ORIGIN }
    if (editor.value.waypoints.length === 0) editor.value.waypoints = RELAY_DEFAULT_ROUTE.waypoints.map(point => ({ ...point }))
    if (editor.value.loiterWaypoints === undefined) editor.value.loiterWaypoints = RELAY_DEFAULT_ROUTE.loiterWaypoints.map(point => ({ ...point }))
  }
  touchField('type')
  synchronizeTypeFields(type)
}

function onSatelliteTypeChange(satelliteType: SatelliteType): void {
  if (editor.value === null || props.editing) return
  const currentName = editor.value.name ? editor.value.name.trim() : ''
  if (currentName === '天通卫星' || currentName === '神通卫星') {
    editor.value.name = satelliteType === 'SHENTONG' ? '神通卫星' : '天通卫星'
  }
}

function onSatelliteTypeFieldChange(satelliteType: SatelliteType): void {
  touchField('satelliteType')
  onSatelliteTypeChange(satelliteType)
}

function setOptionalWaypointValue(waypoint: Waypoint, field: 'heading' | 'acceleration', value: number | undefined | null): void {
  if (value == null) delete waypoint[field]
  else waypoint[field] = value
}

function openWaypointRoute(list: AppendRouteList): void {
  waypointPickerTarget.value = { list, index: null }
  waypointPickerVisible.value = true
}

function applyWaypointMapRoute(points: TemplateRoutePoint[], moved?: ReadonlyMap<number, WaypointMapPoint>): void {
  const target = waypointPickerTarget.value
  const platform = editor.value
  if (!waypointPickerVisible.value || props.pending || props.locked || !platform || !target
    || target.list === 'initialPosition' || target.index !== null || (points.length === 0 && !moved?.size)) return
  // 现有点从原始数组读取，避免把响应式代理放进稍后需要克隆的编辑副本。
  const { waypoints, loiterWaypoints } = toRaw(platform)
  if (target.list === 'loiter') {
    platform.loiterWaypoints = [...(loiterWaypoints ?? []).map((point, index) => ({ ...point, ...moved?.get(index) })), ...points]
    touchField('loiterWaypoints')
  } else {
    // 沿用普通航点的到达时间预填方式，用户可在表格中按任务时序调整。
    const lastPoint = waypoints.at(-1)
    const firstArrival = lastPoint ? lastPoint.arrivalTime + 1 : 0
    platform.waypoints = [
      ...waypoints.map((point, index) => ({ ...point, ...moved?.get(index) })),
      ...points.map((point, index) => ({ ...point, arrivalTime: firstArrival + index })),
    ]
  }
  waypointPickerVisible.value = false
}

function openWaypointPicker(index: number, list: 'waypoints' | TemplateRouteList = 'waypoints'): void {
  const waypoint = list === 'waypoints' ? editor.value?.waypoints[index] : templatePoints(list)?.[index]
  if (waypoint === undefined) return
  waypointPickerTarget.value = { list, index }
  waypointPickerPoint.value = { longitude: waypoint.longitude, latitude: waypoint.latitude }
  waypointPickerVisible.value = true
}

/** 打开初始位置地图选点；仅对支持的类型生效。 */
function openInitialPositionPicker(): void {
  if (editor.value === null || !supportsInitialPositionPicker.value) return
  waypointPickerTarget.value = { list: 'initialPosition' }
  waypointPickerPoint.value = { longitude: editor.value.initialPosition.longitude, latitude: editor.value.initialPosition.latitude }
  waypointPickerVisible.value = true
}

function applyWaypointMapPoint(point: WaypointMapPoint): void {
  const target = waypointPickerTarget.value
  const platform = editor.value
  if (!waypointPickerVisible.value || props.pending || props.locked || !platform || !target) return
  if (target.list === 'initialPosition') {
    platform.initialPosition.longitude = point.longitude
    platform.initialPosition.latitude = point.latitude
    touchField('initialPosition.longitude')
    touchField('initialPosition.latitude')
  } else {
    if (target.index === null) return
    const routePoint = target.list === 'waypoints' ? platform.waypoints[target.index] : templatePoints(target.list)?.[target.index]
    if (!routePoint) return
    routePoint.longitude = point.longitude
    routePoint.latitude = point.latitude
    const field = target.list === 'waypoints' ? 'waypoints' : TEMPLATE_ROUTE_FIELDS[target.list]
    const path = `${field}[${target.index}]`
    if (target.list === 'return') {
      routePoint.altitude = PLATFORM_POINT_DEFAULT_ALTITUDE
      touchField(`${path}.altitude`)
    }
    touchField(`${path}.longitude`)
    touchField(`${path}.latitude`)
  }
  waypointPickerVisible.value = false
}

function resetMapPickers(): void {
  waypointPickerVisible.value = false
  waypointPickerTarget.value = null
}

function removeWaypoint(index: number): void {
  editor.value?.waypoints.splice(index, 1)
}

function apply(): void {
  if (editor.value === null || props.pending || props.locked || cannotAdd.value) return
  confirmationAttempted.value = true
  if (advancedConfig.value && (fieldError('faction') || fieldError('communicationRangeM'))) advancedConfig.value.open = true
  let message = ''
  if (!editor.value.name?.trim()) message = '请填写名称。'
  else if (invalidSpacing.value) message = '节点间隔必须大于 0 km。'
  else if (hasInvalidWaypointSpeed.value) message = waypointSpeedError(editor.value.waypoints.find(point => waypointSpeedError(point.speed))!.speed)
  else if (invalidSatelliteType.value) message = '请选择天通卫星或神通卫星。'
  else if (templateRouteMessage.value) message = templateRouteMessage.value
  if (message) {
    emit('invalid', message)
    return
  }
  // 只提交副本，切换类型时隐藏的编辑内容仍可恢复。
  emit('apply', submission(editor.value), quantity.value, spacingKm.value)
}

watch(() => props.modelValue, (visible) => {
  resetMapPickers()
  if (!visible) return
  if (advancedConfig.value) advancedConfig.value.open = false
  resetValidationState()
  editor.value = props.platform === null ? null : structuredClone(toRaw(props.platform))
  quantity.value = 1
  spacingKm.value = 1
  if (editor.value !== null) synchronizeTypeFields(editor.value.type)
}, { immediate: true })
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="platform-editor-dialog scenario-dialog"
    :title="editing ? '编辑节点' : '新增节点'"
    width="min(1120px, calc(100vw - 2rem))"
    destroy-on-close
    append-to-body
    data-testid="platform-dialog"
    @update:model-value="emit('update:modelValue', $event)"
    @closed="resetMapPickers"
  >
    <el-alert v-if="error" class="platform-feedback" type="error" :closable="false" :title="error" show-icon />
    <el-form v-if="editor" class="platform-editor-form" :model="editor" label-position="top" :disabled="pending || locked">
      <section class="platform-editor-section" aria-labelledby="platform-basic-title">
        <h4 id="platform-basic-title" class="platform-editor-section__title">基本信息</h4>
        <div class="platform-editor-grid">
          <el-form-item required v-show="showIds" label="节点 ID" :error="fieldError('id')">
            <el-input v-model="editor.id" :disabled="editing" data-testid="platform-id" @input="touchField('id')" @update:model-value="touchField('id')" />
          </el-form-item>
          <el-form-item label="名称" required :error="fieldError('name', !editor.name?.trim() ? '请填写名称。' : '')">
            <el-input v-model="editor.name" data-testid="platform-name" @input="touchField('name')" @update:model-value="touchField('name')" />
          </el-form-item>
          <el-form-item required label="节点类型" :error="fieldError('type')">
            <el-select v-model="editor.type" placeholder="请选择节点类型" style="width: 100%" data-testid="platform-type" @change="onPlatformTypeChange">
              <el-option-group label="信息节点">
                <el-option v-for="option in businessTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-option-group>
              <el-option-group :label="`支撑实体（不计入${INFORMATION_NODE_LIMIT}个信息节点）`">
                <el-option v-for="option in supportingTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-option-group>
            </el-select>
            <span v-if="selectedBusinessType" class="platform-editor-field__hint">
              当前 {{ businessTypeCounts[selectedBusinessType] }} / {{ businessTypeLimits[selectedBusinessType] }} 个{{ (props.businessNodeCount ?? 0) >= INFORMATION_NODE_LIMIT ? `（信息节点已达 ${INFORMATION_NODE_LIMIT} 个上限）` : '' }}
            </span>
          </el-form-item>
          <el-form-item v-if="editor.type === 'COMMUNICATION_SATELLITE'" label="卫星类型" required :error="fieldError('satelliteType', invalidSatelliteType ? '请选择天通卫星或神通卫星。' : '')">
            <el-select v-model="editor.satelliteType" placeholder="请选择卫星类型" style="width: 100%" data-testid="platform-satellite-type" @change="onSatelliteTypeFieldChange">
              <el-option v-for="option in satelliteTypeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item required v-if="showBatchQuantity" label="新增数量">
            <el-input-number v-model="quantity" :min="availableQuantity === 0 ? 0 : 1" :max="availableQuantity" :disabled="cannotAdd" :precision="0" controls-position="right" data-testid="platform-quantity" />
            <span class="platform-editor-field__hint">该类型还可新增 {{ availableQuantity }} 个，批量节点可在新增后逐个编辑。</span>
          </el-form-item>
          <el-form-item label="部署域">
            <el-input :model-value="deploymentDomainLabels[editor.category]" readonly data-testid="platform-category" />
          </el-form-item>
        </div>
      </section>

      <details ref="advancedConfig" class="scenario-advanced" data-testid="platform-advanced">
        <summary>高级配置</summary>
        <div class="platform-editor-grid">
          <el-form-item label="所属阵营" :error="fieldError('faction')">
            <el-select :model-value="editor.faction" clearable placeholder="默认（按节点类型推断）" style="width: 100%" data-testid="platform-faction" @update:model-value="setFaction">
              <el-option v-for="option in FACTION_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="节点通信范围（km）" :error="fieldError('communicationRangeM')">
            <el-input-number :model-value="communicationRangeKm" :min="0" :step="1" controls-position="right" placeholder="未配置" data-testid="platform-communication-range" @update:model-value="setCommunicationRangeKm" />
            <small :class="{ 'platform-editor-field__hint--hidden': !!fieldError('communicationRangeM') }" class="platform-editor-field__hint">范围 0～∞ km；0 表示未配置。</small>
          </el-form-item>
        </div>
      </details>

      <section class="platform-editor-section" aria-labelledby="platform-position-title">
        <div class="waypoint-heading">
          <h4 id="platform-position-title" class="platform-editor-section__title">{{ initialPositionLabel }}</h4>
          <el-button v-if="supportsInitialPositionPicker" size="small" :disabled="pending || locked" data-testid="pick-initial-position" @click="openInitialPositionPicker">地图选点</el-button>
        </div>
        <span v-if="editor.type === 'AIRBORNE_MISSION_CLUSTER'" class="platform-editor-field__hint" data-testid="formation-origin-hint">此处仅设置整个集群的编队原点，不单独配置各成员位置。</span>
        <p v-if="isSatellite" class="platform-editor-field__hint" data-testid="satellite-geo-position">GEO 轨道，定点 0°N 120°E，高度 35786 km</p>
        <div v-else class="position-grid">
          <el-form-item required label="经度（°）" :error="fieldError('initialPosition.longitude')"><el-input-number v-model="editor.initialPosition.longitude" :min="validate === undefined ? positionRule?.minLongitude ?? -180 : undefined" :max="validate === undefined ? positionRule?.maxLongitude ?? 180 : undefined" controls-position="right" data-testid="platform-longitude" @input="touchField('initialPosition.longitude')" @update:model-value="touchField('initialPosition.longitude')" /></el-form-item>
          <el-form-item required label="纬度（°）" :error="fieldError('initialPosition.latitude')"><el-input-number v-model="editor.initialPosition.latitude" :min="validate === undefined ? positionRule?.minLatitude ?? -90 : undefined" :max="validate === undefined ? positionRule?.maxLatitude ?? 90 : undefined" controls-position="right" data-testid="platform-latitude" @input="touchField('initialPosition.latitude')" @update:model-value="touchField('initialPosition.latitude')" /></el-form-item>
          <el-form-item required label="高度（m）" :error="fieldError('initialPosition.altitude')"><el-input-number v-model="editor.initialPosition.altitude" :min="validate === undefined ? 0 : undefined" controls-position="right" data-testid="platform-altitude" @input="touchField('initialPosition.altitude')" @update:model-value="touchField('initialPosition.altitude')" /></el-form-item>
        </div>
        <div v-if="showGridSpacing" class="position-grid">
          <el-form-item required label="节点间隔（km）" :error="fieldError('spacingKm', invalidSpacing ? '节点间隔必须大于 0 km。' : '')">
            <el-input-number v-model="spacingKm" :min="0" :step="0.1" :disabled="cannotAdd" controls-position="right" data-testid="platform-spacing" @input="touchField('spacingKm')" @update:model-value="touchField('spacingKm')" />
          </el-form-item>
        </div>
        <span v-if="showGridSpacing" class="platform-editor-field__hint">以编队原点为中心方形平铺，默认相邻节点间隔 1 km；不足一行时居中排列，高度保持一致。</span>
        <span v-if="batchAdding" class="platform-editor-field__hint" data-testid="batch-route-hint">批量新增的无人机使用相同的盘旋和返航配置，新增后可逐个调整。</span>
      </section>

      <section v-if="supportsWaypoints" class="platform-editor-section" aria-labelledby="platform-waypoint-title">
        <div class="waypoint-heading">
          <h4 id="platform-waypoint-title" class="platform-editor-section__title">航点配置（{{ editor.waypoints.length }}）</h4>
          <el-button size="small" :disabled="pending || locked" data-testid="add-waypoint" @click="openWaypointRoute('waypoints')">新增航点</el-button>
        </div>
        <p v-if="fieldError('waypoints')" class="platform-editor-field__error">{{ fieldError('waypoints') }}</p>
        <p v-else class="platform-editor-field__hint">航点非必填，按顺序飞行，之后进入盘旋航点。经度、纬度、高度、速度、到达时间均为必填，速度至少为 1 m/s，到达时间须严格递增且不超过场景时长。</p>
        <el-table class="waypoint-table" :data="editor.waypoints" empty-text="暂无航点" data-testid="waypoint-table">
          <el-table-column label="经度（°） *" min-width="106"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`waypoints[${$index}].longitude`)"><el-input-number v-model="row.longitude" :min="validate === undefined ? waypointBounds?.minLongitude ?? -180 : undefined" :max="validate === undefined ? waypointBounds?.maxLongitude ?? 180 : undefined" controls-position="right" :data-testid="`waypoint-longitude-${$index}`" @input="touchField(`waypoints[${$index}].longitude`)" @update:model-value="touchField(`waypoints[${$index}].longitude`)" /></el-form-item></template></el-table-column>
          <el-table-column label="纬度（°） *" min-width="100"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`waypoints[${$index}].latitude`)"><el-input-number v-model="row.latitude" :min="validate === undefined ? waypointBounds?.minLatitude ?? -90 : undefined" :max="validate === undefined ? waypointBounds?.maxLatitude ?? 90 : undefined" controls-position="right" :data-testid="`waypoint-latitude-${$index}`" @input="touchField(`waypoints[${$index}].latitude`)" @update:model-value="touchField(`waypoints[${$index}].latitude`)" /></el-form-item></template></el-table-column>
          <el-table-column label="高度（m） *" min-width="92"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`waypoints[${$index}].altitude`)"><el-input-number v-model="row.altitude" :min="validate === undefined ? 0 : undefined" controls-position="right" :data-testid="`waypoint-altitude-${$index}`" @input="touchField(`waypoints[${$index}].altitude`)" @update:model-value="touchField(`waypoints[${$index}].altitude`)" /></el-form-item></template></el-table-column>
          <el-table-column label="速度（m/s）*" min-width="108"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`waypoints[${$index}].speed`, waypointSpeedError(row.speed))"><el-input-number v-model="row.speed" :min="1" placeholder="至少为 1" controls-position="right" :aria-invalid="Boolean(fieldError(`waypoints[${$index}].speed`, waypointSpeedError(row.speed)))" :data-testid="`waypoint-speed-${$index}`" @input="touchField(`waypoints[${$index}].speed`)" @update:model-value="touchField(`waypoints[${$index}].speed`)" /></el-form-item></template></el-table-column>
          <el-table-column label="航向（°）" min-width="88"><template #default="{ row, $index }"><el-form-item :error="fieldError(`waypoints[${$index}].heading`)"><el-input-number :model-value="row.heading" :min="0" :max="360" controls-position="right" :data-testid="`waypoint-heading-${$index}`" @input="touchField(`waypoints[${$index}].heading`)" @update:model-value="setOptionalWaypointValue(row, 'heading', $event); touchField(`waypoints[${$index}].heading`)" /></el-form-item></template></el-table-column>
          <el-table-column label="加速度（m/s²）" min-width="106"><template #default="{ row, $index }"><el-form-item :error="fieldError(`waypoints[${$index}].acceleration`)"><el-input-number :model-value="row.acceleration" controls-position="right" :data-testid="`waypoint-acceleration-${$index}`" @input="touchField(`waypoints[${$index}].acceleration`)" @update:model-value="setOptionalWaypointValue(row, 'acceleration', $event); touchField(`waypoints[${$index}].acceleration`)" /></el-form-item></template></el-table-column>
          <el-table-column label="到达时间（s） *" min-width="108"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`waypoints[${$index}].arrivalTime`)"><el-input-number v-model="row.arrivalTime" :min="0" controls-position="right" :data-testid="`waypoint-arrival-${$index}`" @input="touchField(`waypoints[${$index}].arrivalTime`)" @update:model-value="touchField(`waypoints[${$index}].arrivalTime`)" /></el-form-item></template></el-table-column>
          <el-table-column label="操作" width="124" class-name="waypoint-actions">
            <template #default="{ $index }">
              <el-button v-if="supportsWaypoints" link type="primary" :disabled="pending || locked" :data-testid="`pick-waypoint-${$index}`" @click="openWaypointPicker($index)">地图选点</el-button>
              <el-button link type="danger" :disabled="pending || locked" :data-testid="`delete-waypoint-${$index}`" @click="removeWaypoint($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-for="list in visibleTemplateRoutes" :key="list" class="platform-editor-section" :aria-labelledby="`platform-${list}-title`" :data-testid="`${list}-section`">
        <div class="waypoint-heading">
          <h4 :id="`platform-${list}-title`" class="platform-editor-section__title">{{ list === 'loiter' ? `盘旋航点（${editor.loiterWaypoints?.length ?? 0}）` : `返航路线（${editor.returnPlan?.waypoints.length ?? 0}）` }}</h4>
          <el-switch v-if="list === 'return'" :model-value="editor.returnPlan !== undefined" inline-prompt active-text="返航" inactive-text="不返航" aria-label="启用返航" data-testid="return-enabled" @change="toggleReturnPlan" />
          <el-button v-if="list === 'loiter' || editor.returnPlan" size="small" :disabled="pending || locked" :data-testid="`add-${list}-waypoint`" @click="list === 'loiter' ? openWaypointRoute('loiter') : addReturnWaypoint()">{{ list === 'loiter' ? '新增盘旋航点' : '新增返航路线航点' }}</el-button>
        </div>
        <p v-if="list === 'loiter'" class="platform-editor-field__hint">盘旋航点在航线末尾循环飞行；非必填，配置时至少 2 个点，速度须大于 0。</p>
        <p v-else class="platform-editor-field__hint">开启后从返航时刻起沿返航路线依次飞行，飞完最后一个航点即结束；返航时刻须大于 0 且早于仿真结束时刻，返航路线至少 1 个航点，直飞回基地只需填 1 个。</p>
        <div v-if="list === 'return' && editor.returnPlan" class="position-grid">
          <el-form-item required label="返航时刻（仿真秒）" :error="fieldError('returnPlan.timeS', returnTimeValid(editor.returnPlan.timeS) ? '' : RETURN_TIME_ERROR)">
            <el-input-number v-model="editor.returnPlan.timeS" :min="0" placeholder="请输入返航时刻" controls-position="right" data-testid="return-time" @input="touchField('returnPlan.timeS')" @update:model-value="touchField('returnPlan.timeS')" />
          </el-form-item>
        </div>
        <template v-if="list === 'loiter' || editor.returnPlan">
          <p v-if="templateRouteListError(list)" class="platform-editor-field__error" :data-testid="`${list}-list-error`">{{ templateRouteListError(list) }}</p>
          <el-table :data="templatePoints(list) ?? []" :empty-text="list === 'loiter' ? '暂无盘旋航点' : '返航路线暂无航点'" :data-testid="`${list}-table`">
            <el-table-column label="经度（°） *" min-width="130"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].longitude`)"><el-input-number v-model="row.longitude" :min="validate === undefined ? -180 : undefined" :max="validate === undefined ? 180 : undefined" controls-position="right" :data-testid="`${list}-longitude-${$index}`" @input="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].longitude`)" @update:model-value="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].longitude`)" /></el-form-item></template></el-table-column>
            <el-table-column label="纬度（°） *" min-width="130"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].latitude`)"><el-input-number v-model="row.latitude" :min="validate === undefined ? -90 : undefined" :max="validate === undefined ? 90 : undefined" controls-position="right" :data-testid="`${list}-latitude-${$index}`" @input="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].latitude`)" @update:model-value="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].latitude`)" /></el-form-item></template></el-table-column>
            <el-table-column label="高度（m） *" min-width="130"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].altitude`)"><el-input-number v-model="row.altitude" :min="validate === undefined ? 0 : undefined" controls-position="right" :data-testid="`${list}-altitude-${$index}`" @input="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].altitude`)" @update:model-value="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].altitude`)" /></el-form-item></template></el-table-column>
            <el-table-column label="速度（m/s）*" min-width="160"><template #default="{ row, $index }"><el-form-item required :error="fieldError(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].speed`, waypointSpeedError(row.speed) ? TEMPLATE_ROUTE_SPEED_ERROR : '')"><el-input-number v-model="row.speed" :min="1" placeholder="请输入至少为 1 的速度" controls-position="right" :data-testid="`${list}-speed-${$index}`" @input="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].speed`)" @update:model-value="touchField(`${TEMPLATE_ROUTE_FIELDS[list]}[${$index}].speed`)" /></el-form-item></template></el-table-column>
            <el-table-column label="操作" width="260" class-name="waypoint-actions">
              <template #default="{ $index }">
                <el-button link type="primary" :disabled="pending || locked" :data-testid="`pick-${list}-${$index}`" @click="openWaypointPicker($index, list)">地图选点</el-button>
                <el-button link :disabled="pending || locked || $index === 0" :aria-label="`上移第 ${$index + 1} 个航点`" :data-testid="`move-up-${list}-${$index}`" @click="moveTemplatePoint(list, $index, -1)">上移</el-button>
                <el-button link :disabled="pending || locked || $index === (templatePoints(list)?.length ?? 0) - 1" :aria-label="`下移第 ${$index + 1} 个航点`" :data-testid="`move-down-${list}-${$index}`" @click="moveTemplatePoint(list, $index, 1)">下移</el-button>
                <el-button link type="danger" :disabled="pending || locked" :data-testid="`delete-${list}-${$index}`" @click="removeTemplatePoint(list, $index)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </section>
    </el-form>
    <template #footer>
      <el-button data-testid="cancel-platform" @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="pending || locked || cannotAdd" data-testid="apply-platform" @click="apply">确认</el-button>
    </template>
  </el-dialog>

  <WaypointMapPicker
    v-if="supportsWaypoints || supportsLoiter || supportsInitialPositionPicker"
    v-model="waypointPickerVisible"
    :route="waypointPickerRoute"
    :route-context="waypointPickerContext"
    :title="pickingInitialPosition ? `地图选取${initialPositionLabel}` : undefined"
    :hint="pickingInitialPosition ? `单击地图选择${initialPositionLabel}的经纬度。` : pickingReturnWaypoint ? undefined : '单击地图微调该航点的经纬度。'"
    :empty-text="pickingInitialPosition ? `尚未选择${initialPositionLabel}` : undefined"
    :show-altitude="pickingReturnWaypoint"
    :allow-zero-point="!pickingReturnWaypoint"
    :longitude="waypointPickerPoint.longitude"
    :latitude="waypointPickerPoint.latitude"
    :bounds="waypointPickerBounds"
    :existing-nodes="existingNodes"
    :fit-existing-nodes="pickingInitialPosition && !editing"
    @confirm="applyWaypointMapPoint"
    @confirm-route="applyWaypointMapRoute"
  />
</template>

<style scoped>
.platform-feedback {
  margin-bottom: 1rem;
}

.platform-editor-grid,
.position-grid {
  display: grid;
  gap: 0 1rem;
}

.platform-editor-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.platform-editor-form {
  display: grid;
  gap: 0.5rem;
}

.platform-editor-field__hint--hidden { visibility: hidden; }
:deep(.el-form-item.is-error:has(.platform-editor-field__hint--hidden) .el-form-item__error) { transform: translateY(-1.5em); }
.platform-editor-field__hint {
  display: block;
  margin-top: 0.25rem;
  color: var(--console-text-muted);
  font-size: 12px;
  line-height: 1.4;
}

.platform-editor-field__error {
  margin: 0.25rem 0;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.4;
}

.platform-editor-section {
  min-width: 0;
}

.platform-editor-section__title {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0 0 0.375rem;
  color: var(--console-cyan);
  font-size: 0.75rem;
  letter-spacing: 0.06em;
}

.platform-editor-section__title::after {
  flex: 1;
  border-top: 1px solid var(--console-border);
  content: '';
}

.platform-editor-form :deep(.el-form-item) {
  /* 为绝对定位的校验红字预留一行。 */
  margin-bottom: 1.25rem;
}

.platform-editor-form :deep(.el-form-item__label) {
  margin-bottom: 0.25rem;
  line-height: 1.25rem;
}

.platform-editor-form :deep(.el-form-item__error) {
  position: static;
}

.platform-editor-form :deep(.el-input-number) {
  width: 100%;
}

.platform-editor-form :deep(.el-select__wrapper .el-tag) {
  --el-tag-bg-color: rgb(13 48 65 / 90%);
  --el-tag-border-color: var(--console-border-strong);
  --el-tag-text-color: var(--console-text);
}

.position-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.platform-editor-form :deep(.waypoint-actions .cell) {
  white-space: nowrap;
}

.waypoint-table :deep(.cell) {
  padding-inline: 8px;
}

.waypoint-table :deep(.el-input-number.is-controls-right .el-input__wrapper) {
  padding-inline: 6px 28px;
}

.waypoint-table :deep(.el-input-number__increase),
.waypoint-table :deep(.el-input-number__decrease) {
  width: 24px;
}

.waypoint-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.375rem;
}

.waypoint-heading .platform-editor-section__title {
  flex: 1;
  margin-bottom: 0;
}

:global(.platform-editor-dialog .el-dialog__close) {
  color: var(--console-text);
}

:global(.platform-editor-dialog .el-dialog__headerbtn:hover .el-dialog__close) {
  color: var(--console-cyan);
}

@media (max-width: 960px) {
  .platform-editor-grid,
  .position-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .platform-editor-grid,
  .position-grid {
    grid-template-columns: 1fr;
  }
}
</style>
