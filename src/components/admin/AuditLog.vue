<script setup lang="ts">
import { ref } from 'vue'

// 时间范围
const timeRange = ref<[Date, Date] | null>(null)
// 角色下拉
const roleValue = ref('')
const roleOptions = ref([
  { label: '全部角色', value: '' },
  { label: 'admin', value: 'admin' },
  { label: 'operator', value: 'operator' },
])
// 操作类型下拉
const opTypeValue = ref('')
const opTypeOptions = ref([
  { label: '全部操作类型', value: '' },
  { label: '参数修改', value: 'param_modify' },
  { label: '仿真操作', value: 'simulate' },
  { label: '登录', value: 'login' },
])

// 原型图内置演示记录
const tableData = ref([
  {
    time: '08‑06 10:32:11',
    identity: 'admin',
    opType: '参数修改',
    opTarget: 'SNR 最低门限',
    change: '12 dB → 10 dB',
    result: '成功',
    isRisk: false,
  },
  {
    time: '08‑06 09:15:44',
    identity: 'operator',
    opType: '仿真操作',
    opTarget: '强电磁干扰场景',
    change: '−',
    result: '成功',
    isRisk: false,
  },
  {
    time: '08‑05 16:20:33',
    identity: 'operator',
    opType: '登录',
    opTarget: '系统',
    change: '−',
    result: '成功',
    isRisk: false,
  },
  {
    time: '08‑05 15:58:02',
    identity: 'operator',
    opType: '参数修改',
    opTarget: 'BER 阈值',
    change: '越权尝试',
    result: '已拦截',
    isRisk: true, // 风险行红色高亮标记
  },
])

// 查询按钮
const handleQuery = () => {
  console.log('查询条件', { timeRange, roleValue, opTypeValue })
  // 这里后续对接接口替换 tableData
}
// 模拟导出
const handleMockExport = () => {
  console.log('模拟导出（只读）')
}

// 表格行样式回调：越权行背景浅红
const tableRowClassName = ({ row }: { row: any }) => {
  return row.isRisk ? 'risk-row' : ''
}
</script>

<template>
  <div class="audit-log-card">
    <h3 class="audit-title">操作审计日志（内置演示记录）</h3>
    <!-- 筛选栏 -->
    <div class="filter-bar">
      <el-date-picker
          v-model="timeRange"
          type="daterange"
          range-separator="~"
          start-placeholder="开始时间"
          end-placeholder="结束时间"
          single-panel
          style="width: 180px;"
      />

      <el-select v-model="roleValue" placeholder="全部角色" style="width: 180px;">
        <el-option
            v-for="item in roleOptions"
            :key="item.value"
            :label="item.label"
            :value="item.value"
        />
      </el-select>

      <el-select v-model="opTypeValue" placeholder="全部操作类型" style="width: 180px; padding: 10px;">
        <el-option
            v-for="item in opTypeOptions"
            :key="item.value"
            :label="item.label"
            :value="item.value"
        />
      </el-select>

      <el-button type="primary" @click="handleQuery">查询</el-button>
      <el-button @click="handleMockExport">模拟导出（只读）</el-button>
    </div>

    <!-- 审计表格 -->
    <el-table
        :data="tableData"
        stripe
        :row-class-name="tableRowClassName"
        style="width: 100%"
    >
      <el-table-column prop="time" label="时间" />
      <el-table-column prop="identity" label="身份" />
      <el-table-column prop="opType" label="操作类型" />
      <el-table-column prop="opTarget" label="操作对象" />
      <el-table-column prop="change" label="修改前 → 修改后" />
      <el-table-column prop="result" label="结果"  />
    </el-table>

  </div>
</template>

<style scoped>
.audit-log-card {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 10px;
}

.audit-title {
  padding:0 0 10px 10px;
  margin: 0;
  font-size: 18px;
  font-weight: 500;
  border-bottom: 1px solid #1e3448;;
}
/* 越权风险行 浅红底色 */
:deep(.risk-row) {
  background-color: #fff2f2 !important;
}
:deep(.risk-row td) {
  color: #e53935;
}
.filter-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: nowrap !important; /* 关键：禁止换行，全部强制在同一行 */
}


@media (max-width: 640px) {
  .filter-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
