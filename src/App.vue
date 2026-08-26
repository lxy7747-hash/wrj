<template>
  <main class="shell" aria-labelledby="app-title">
    <section class="shell__panel">
      <p class="shell__mark" aria-label="产品标识">WRJ</p>
      <h1 id="app-title">多手段集群通联仿真软件</h1>
      <p class="shell__status" role="status">P0 基础设施已启用</p>
      <p class="shell__note">当前仅提供本地前端工程外壳，业务能力将在后续阶段接入。</p>
    </section>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  color: #e8f2ff;
  background: #07111f;
  font-family:
    Inter, "Microsoft YaHei", "PingFang SC", system-ui, -apple-system, sans-serif;
}

.shell {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 2rem;
}

.shell__panel {
  width: min(40rem, 100%);
  padding: 3rem;
  border: 1px solid #315275;
  border-radius: 0.75rem;
  background: #0d1c2e;
  text-align: center;
}

.shell__mark {
  margin: 0 0 0.75rem;
  color: #6fc3ff;
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.25em;
}

h1 {
  margin: 0;
  font-size: clamp(1.5rem, 4vw, 2.25rem);
}

.shell__status {
  margin: 1.5rem 0 0;
  color: #7ce2b8;
  font-weight: 700;
}

.shell__note {
  margin: 0.75rem 0 0;
  color: #a9bed4;
  line-height: 1.6;
}
</style>
