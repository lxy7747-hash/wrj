<script setup lang="ts">
import { computed } from 'vue'
import { useDataExchangeStore } from '../../stores/data-exchange'

const store = useDataExchangeStore()
const externalInterfaces = computed(() => store.interfaces.filter((item) => item.kind === '外部'))
const internalInterfaces = computed(() => store.interfaces.filter((item) => item.kind === '内部'))
const descriptions: Record<string, string> = {
  'DSDWRJQTLJS-JK-YHCZ': '鼠标、键盘和表单输入 → 图表、表格、提示与确认反馈。',
  'DSDWRJQTLJS-JK-WJXT': 'JSON、TXT、CSV、SQLite、HTML、PDF 的路径、元数据及读写结果合同。',
  'DSDWRJQTLJS-JK-CZXT': '进程、系统时间、内存与磁盘的 PID、状态、stdout、退出码和资源释放合同。',
  'DSDWRJQTLJS-JK-QDZS-SJJHYJK': '回环版本化消息、REST 快照和主题订阅。',
  'DSDWRJQTLJS-JK-SJJHYJK-FZYXYLLJS': '本机进程控制、插件回调、逐帧结果和受控 CSV。',
  'DSDWRJQTLJS-JK-CJPZYJBSC-WJXT': '已校验 JSON → 脚本预览、校验和与错误报告。',
  'DSDWRJQTLJS-JK-CSCI-SJJH': '统一 ID、明确所有者、同 frameId 和无循环调用。',
}
</script>

<template>
  <el-card class="interface-card" shadow="never" data-testid="interface-contract-table">
    <template #header><div class="exchange-card__header"><div><p class="eyebrow">P5-5 · T-JK-001～007</p><h3>七类接口合同</h3></div><el-tag type="success" effect="dark">3 类外部 + 4 类内部</el-tag></div></template>
    <div class="interface-groups">
      <section aria-labelledby="external-interface-title">
        <h4 id="external-interface-title">外部接口</h4>
        <article v-for="item in externalInterfaces" :id="item.destination" :key="item.id" class="interface-item">
          <strong>{{ item.name }}</strong><code>{{ item.id }}</code><p>{{ descriptions[item.id] }}</p>
        </article>
      </section>
      <section aria-labelledby="internal-interface-title">
        <h4 id="internal-interface-title">内部接口</h4>
        <article v-for="item in internalInterfaces" :id="item.destination" :key="item.id" class="interface-item">
          <strong>{{ item.name }}</strong><code>{{ item.id }}</code><p>{{ descriptions[item.id] }}</p>
        </article>
      </section>
    </div>
    <el-table :data="store.frontendContracts" size="small" data-testid="frontend-contracts">
      <el-table-column prop="name" label="规范数据结构" min-width="160" />
      <el-table-column prop="version" label="版本" width="80" />
      <el-table-column label="字段"><template #default="scope">{{ scope.row.fields.join('、') }}</template></el-table-column>
    </el-table>
  </el-card>
</template>
