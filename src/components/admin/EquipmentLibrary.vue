<template>
  <div class="param-db-card" data-testid="equipment-library">
    <!-- 头部 -->
    <div class="card-header">
      <h3 class="card-title">装备基础参数库（内置主数据）</h3>
      <el-button class="import-btn">
        导入参数包
        <span class="tag-label">仅管理员</span>
      </el-button>
    </div>

    <!-- 表格 -->
    <el-table :data="tableData" border style="width:100%">
      <el-table-column prop="code" label="编号" />
      <el-table-column prop="type" label="类型" />
      <el-table-column prop="freqBand" label="默认频段" />
      <el-table-column prop="modulate" label="默认调制" />
      <el-table-column prop="failThreshold" label="失效阈值" />
      <el-table-column prop="readOnly" label="只读" />
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button link @click="openView(row)">查看</el-button>
          <el-button link @click="openEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 底部状态提示栏 -->
    <div class="status-bar">
      SUCCESS：参数包导入校验夹具已完成；未读取文件。
    </div>

    <!-- 查看弹窗（只读） -->
    <el-dialog
        v-model="viewVisible"
        title="查看参数详情"
        width="500px"
        :close-on-click-modal="false"
    >
      <el-descriptions :column="1" border>
        <el-descriptions-item label="编号">{{ viewForm.code }}</el-descriptions-item>
        <el-descriptions-item label="类型">{{ viewForm.type }}</el-descriptions-item>
        <el-descriptions-item label="默认频段">{{ viewForm.freqBand }}</el-descriptions-item>
        <el-descriptions-item label="默认调制">{{ viewForm.modulate }}</el-descriptions-item>
        <el-descriptions-item label="失效阈值">{{ viewForm.failThreshold }}</el-descriptions-item>
        <el-descriptions-item label="只读">{{ viewForm.readOnly }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="viewVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 编辑弹窗 -->
    <el-dialog
        v-model="editVisible"
        title="编辑参数"
        width="500px"
        :close-on-click-modal="false"
    >
      <el-form :model="editForm" label-width="100px">
        <el-form-item label="编号">
          <el-input v-model="editForm.code" disabled />
        </el-form-item>
        <el-form-item label="类型">
          <el-input v-model="editForm.type" />
        </el-form-item>
        <el-form-item label="默认频段">
          <el-input v-model="editForm.freqBand" />
        </el-form-item>
        <el-form-item label="默认调制">
          <el-input v-model="editForm.modulate" />
        </el-form-item>
        <el-form-item label="失效阈值">
          <el-input v-model="editForm.failThreshold" />
        </el-form-item>
        <el-form-item label="只读">
          <el-switch
              v-model="editForm.readOnlyBool"
              active-text="是"
              inactive-text="否"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'

const tableData = ref([
  { code: "UAV-STD", type: "高空前出中继节点", freqBand: "-", modulate: "-", failThreshold: "-", readOnly: "是" },
  { code: "SAT-COMM", type: "卫星链路", freqBand: "12 GHz", modulate: "QPSK", failThreshold: "1e-5", readOnly: "是" },
  { code: "MW-COMM", type: "微波链路", freqBand: "8 GHz", modulate: "QPSK", failThreshold: "1e-5", readOnly: "是" },
  { code: "DL-COMM", type: "新一代数传链路", freqBand: "1.2 GHz", modulate: "BPSK", failThreshold: "1e-5", readOnly: "是" },
  { code: "LASER-COMM", type: "激光链路", freqBand: "光载波", modulate: "-", failThreshold: "1e-5", readOnly: "是" },
  { code: "JAM-WB", type: "宽带压制干扰", freqBand: "0.1-20 GHz", modulate: "-", failThreshold: "-", readOnly: "否" },
  { code: "JAM-SPOT", type: "瞄准式干扰", freqBand: "可配置", modulate: "-", failThreshold: "-", readOnly: "否" }
])

// ========== 查看弹窗 ==========
const viewVisible = ref(false)
const viewForm = reactive({
  code: '', type: '', freqBand: '', modulate: '', failThreshold: '', readOnly: ''
})
const openView = (row) => {
  Object.assign(viewForm, row)
  viewVisible.value = true
}

// ========== 编辑弹窗 ==========
const editVisible = ref(false)
const editForm = reactive({
  code: '', type: '', freqBand: '', modulate: '', failThreshold: '',
  readOnlyBool: false,  // 开关用布尔
  _index: -1             // 记录原行索引
})
const openEdit = (row) => {
  const idx = tableData.value.findIndex(item => item.code === row.code)
  editForm.code = row.code
  editForm.type = row.type
  editForm.freqBand = row.freqBand
  editForm.modulate = row.modulate
  editForm.failThreshold = row.failThreshold
  editForm.readOnlyBool = row.readOnly === '是'
  editForm._index = idx
  editVisible.value = true
}
const saveEdit = () => {
  const idx = editForm._index
  if (idx > -1) {
    tableData.value[idx] = {
      code: editForm.code,
      type: editForm.type,
      freqBand: editForm.freqBand,
      modulate: editForm.modulate,
      failThreshold: editForm.failThreshold,
      readOnly: editForm.readOnlyBool ? '是' : '否'
    }
  }
  editVisible.value = false
}
</script>

<style scoped>
.param-db-card {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 16px;
}
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.card-title {
  margin: 0;
  font-size: 18px;
  font-weight: 500;
}
.import-btn {
  color: var(--el-color-primary) !important;
  background-color: #fff !important;
}
.tag-label {
  background: #fef0d9;
  color: #e6a23c;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: 6px;
}
.status-bar {
  margin-top: 12px;
  background-color: var(--el-fill-color-light);
  border-left: 4px solid var(--el-color-primary);
  padding: 10px 14px;
  font-size: 15px;
  color: var(--el-text-color-primary);
}
</style>
