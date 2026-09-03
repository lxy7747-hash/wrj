<template>
  <div class="audit-log">
    <header class="audit-log__header">
      <div>
        <p class="eyebrow">系统管理 / 账号与维护</p>
        <h2 id="audit-logs-title">操作审计日志</h2>
        <p class="audit-log__description">查看系统操作的审计记录。</p>
      </div>
    </header>

    <el-empty description="暂无审计日志" />
  </div>
</template>

<style scoped>
.audit-log {
  display: grid;
  min-width: 0;
  gap: var(--space-4, 1rem);
}

.audit-log__header {
  padding-bottom: var(--space-4, 1rem);
  border-bottom: 1px solid var(--console-border);
}

.audit-log__description {
  margin: 0;
  color: var(--console-text-muted);
  font-size: 0.88rem;
}

@media (max-width: 560px) {
  .audit-log {
    gap: var(--space-3, 0.75rem);
  }
}
</style>
