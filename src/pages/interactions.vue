<template>
  <section class="page interactions-page" aria-labelledby="interactions-title">
    <header class="interactions-page__header">
      <div>
        <p class="eyebrow">能力治理 / 交互管理</p>
        <h2 id="interactions-title">交互管理</h2>
        <p class="interactions-page__summary">
          以感知、控制与链路决策的关系组织未来交互信息；当前页面仅说明规划边界。
        </p>
      </div>
      <span class="console-chip interactions-page__chip">规划信息架构</span>
    </header>

    <el-alert
      class="construction-alert"
      type="info"
      :closable="false"
      title="功能建设中"
      description="本入口将承载交互管理业务域；当前不提供业务操作或业务数据。"
    />

    <section class="console-panel interaction-topology" aria-labelledby="topology-title">
      <header class="interaction-topology__header">
        <div>
          <p class="section-kicker">PLANNING TOPOLOGY</p>
          <h3 id="topology-title">交互规划关系</h3>
        </div>
        <p>以下拓扑仅表达感知输入、控制边界与链路决策之间的规划关系。</p>
      </header>

      <div class="topology-map" aria-hidden="true">
        <div class="topology-map__track topology-map__track--primary"></div>
        <div class="topology-map__track topology-map__track--secondary"></div>
        <span class="topology-map__node topology-map__node--sense"></span>
        <span class="topology-map__node topology-map__node--control"></span>
        <span class="topology-map__node topology-map__node--link"></span>
      </div>

      <ol class="domain-list" aria-label="交互规划区域">
        <li class="domain-card domain-card--sense">
          <div class="domain-card__heading">
            <span class="domain-card__marker" aria-hidden="true"></span>
            <div>
              <p class="domain-card__label">规划区域</p>
              <h4>感知与侦测</h4>
            </div>
          </div>
          <p>后续用于呈现感知设备状态与侦测结果，作为交互信息的输入边界。</p>
          <span class="console-chip">感知输入</span>
        </li>

        <li class="domain-card domain-card--control">
          <div class="domain-card__heading">
            <span class="domain-card__marker" aria-hidden="true"></span>
            <div>
              <p class="domain-card__label">规划区域</p>
              <h4>干扰控制</h4>
            </div>
          </div>
          <p>后续用于管理干扰控制参数与执行过程，明确控制信息的呈现边界。</p>
          <span class="console-chip">控制边界</span>
        </li>

        <li class="domain-card domain-card--link">
          <div class="domain-card__heading">
            <span class="domain-card__marker" aria-hidden="true"></span>
            <div>
              <p class="domain-card__label">规划区域</p>
              <h4>链路优选与切换</h4>
            </div>
          </div>
          <p>后续用于查看链路优选依据与切换决策，形成可理解的链路决策视图。</p>
          <span class="console-chip">链路决策</span>
        </li>
      </ol>

      <p class="interaction-topology__note">
        此处为静态信息架构示例，不表示设备、链路、控制指令或运行状态。
      </p>
    </section>
  </section>
</template>

<style scoped>
.interactions-page {
  min-width: 0;
  overflow: hidden;
}

.interactions-page__header,
.interaction-topology__header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}

.interactions-page__header > div {
  min-width: 0;
}

.interactions-page h2,
.interaction-topology h3,
.domain-card h4 {
  color: var(--console-text);
}

.interactions-page h2 {
  margin: 0;
}

.interactions-page__summary {
  max-width: 45rem;
  margin: var(--space-3) 0 0;
  color: var(--console-text-muted);
  font-size: 0.92rem;
  line-height: 1.7;
}

.interactions-page__chip {
  flex: 0 0 auto;
  margin-top: var(--space-1);
  color: var(--console-teal);
}

.construction-alert {
  margin-top: var(--space-5);
}

.interaction-topology {
  min-width: 0;
  margin-top: var(--space-5);
  overflow: hidden;
  padding: 0;
  background:
    linear-gradient(rgba(66, 216, 255, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(66, 216, 255, 0.03) 1px, transparent 1px),
    var(--console-surface);
  background-size: 1.5rem 1.5rem;
}

.interaction-topology__header {
  align-items: flex-end;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--console-border);
  background: color-mix(in srgb, var(--console-surface-raised) 88%, transparent);
}

.section-kicker,
.domain-card__label {
  margin: 0;
  color: var(--console-cyan);
  font-size: 0.67rem;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.interaction-topology h3 {
  margin: var(--space-1) 0 0;
  font-size: clamp(1rem, 2vw, 1.18rem);
}

.interaction-topology__header > p {
  max-width: 26rem;
  margin: 0;
  color: var(--console-text-dim);
  font-size: 0.75rem;
  line-height: 1.6;
  text-align: right;
}

.topology-map {
  position: relative;
  min-height: 5.5rem;
  margin: var(--space-4) var(--space-5) 0;
  overflow: hidden;
  border: 1px solid var(--console-border);
  border-radius: calc(var(--console-radius) - 2px);
  background: color-mix(in srgb, var(--console-bg-elevated) 90%, transparent);
}

.topology-map__track {
  position: absolute;
  height: 1px;
  background: var(--console-border-strong);
  transform-origin: left center;
}

.topology-map__track::after {
  position: absolute;
  top: 50%;
  right: -1px;
  width: 0.42rem;
  height: 0.42rem;
  border-top: 1px solid var(--console-cyan);
  border-right: 1px solid var(--console-cyan);
  content: '';
  transform: translateY(-50%) rotate(45deg);
}

.topology-map__track--primary {
  top: 50%;
  left: 19%;
  width: 62%;
}

.topology-map__track--secondary {
  top: 28%;
  left: 27%;
  width: 45%;
  opacity: 0.56;
  transform: rotate(18deg);
}

.topology-map__node {
  position: absolute;
  top: 50%;
  width: 0.88rem;
  height: 0.88rem;
  border: 2px solid var(--console-cyan);
  border-radius: 50%;
  background: var(--console-bg-elevated);
  box-shadow: 0 0 0 0.25rem rgba(66, 216, 255, 0.06);
  transform: translate(-50%, -50%);
}

.topology-map__node--sense {
  left: 17%;
  border-color: var(--console-teal);
}

.topology-map__node--control {
  left: 50%;
  border-color: var(--console-amber);
}

.topology-map__node--link {
  left: 83%;
}

.domain-list {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: var(--space-4) 0 0;
  padding: 0 var(--space-5);
  list-style: none;
}

.domain-card {
  display: flex;
  min-width: 0;
  min-height: 12.5rem;
  flex-direction: column;
  align-items: flex-start;
  padding: var(--space-4);
  border: 1px solid var(--console-border);
  border-top-width: 2px;
  border-radius: calc(var(--console-radius) - 2px);
  background: color-mix(in srgb, var(--console-surface-raised) 70%, var(--console-bg-elevated));
}

.domain-card--sense {
  border-top-color: var(--console-teal);
}

.domain-card--control {
  border-top-color: var(--console-amber);
}

.domain-card--link {
  border-top-color: var(--console-cyan);
}

.domain-card__heading {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: var(--space-3);
}

.domain-card__marker {
  width: 0.75rem;
  height: 0.75rem;
  flex: 0 0 auto;
  margin-top: 0.18rem;
  border: 2px solid var(--console-cyan);
  border-radius: 50%;
  background: var(--console-bg-elevated);
}

.domain-card--sense .domain-card__marker {
  border-color: var(--console-teal);
}

.domain-card--control .domain-card__marker {
  border-color: var(--console-amber);
}

.domain-card--control .domain-card__label {
  color: var(--console-amber);
}

.domain-card--sense .domain-card__label {
  color: var(--console-teal);
}

.domain-card h4 {
  margin: var(--space-1) 0 0;
  font-size: 0.95rem;
}

.domain-card > p {
  margin: var(--space-4) 0;
  color: var(--console-text-muted);
  font-size: 0.8rem;
  line-height: 1.7;
}

.domain-card .console-chip {
  margin-top: auto;
  color: var(--console-text-muted);
}

.domain-card--sense .console-chip {
  border-color: color-mix(in srgb, var(--console-teal) 55%, var(--console-border));
  color: var(--console-teal);
}

.domain-card--control .console-chip {
  border-color: color-mix(in srgb, var(--console-amber) 55%, var(--console-border));
  color: var(--console-amber);
}

.interaction-topology__note {
  margin: var(--space-4) var(--space-5) var(--space-5);
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--console-border-strong);
  color: var(--console-text-dim);
  background: color-mix(in srgb, var(--console-bg-elevated) 74%, transparent);
  font-size: 0.76rem;
  line-height: 1.65;
}

@media (max-width: 900px) {
  .domain-list {
    grid-template-columns: repeat(3, minmax(12rem, 1fr));
    overflow-x: auto;
    padding-bottom: var(--space-2);
  }
}

@media (max-width: 640px) {
  .interactions-page__header,
  .interaction-topology__header {
    flex-direction: column;
    gap: var(--space-3);
  }

  .interactions-page__chip {
    margin-top: 0;
  }

  .interaction-topology__header > p {
    max-width: none;
    text-align: left;
  }

  .topology-map,
  .domain-list {
    margin-right: var(--space-4);
    margin-left: var(--space-4);
  }

  .domain-list {
    grid-template-columns: minmax(0, 1fr);
    overflow: visible;
    padding: 0;
  }

  .domain-card {
    min-height: 0;
  }

  .interaction-topology__note {
    margin-right: var(--space-4);
    margin-left: var(--space-4);
  }
}

@media (max-width: 390px) {
  .interaction-topology__header {
    padding: var(--space-4);
  }

  .interactions-page__summary {
    font-size: 0.86rem;
  }
}
</style>
