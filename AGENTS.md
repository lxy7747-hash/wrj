# AGENTS.md — Codex Project Operating Rules

## Repository Safety Preflight

Before the first repository write or any staging operation:

1. Inspect `git status --short --ignored` and the repository's active ignore rules, including `.gitignore` and `.gitattributes` when present.
2. Make an explicit decision for large map assets: ignore them, track them directly, or use Git LFS. For this repository, `/map/` is local-only and ignored; do not use Git LFS, move, delete, or stage its PMTiles files.
3. Verify the decision with `git check-ignore -v -- map/china-taiwan-260823.pmtiles map/taiwan-strait-satellite.pmtiles`. Both paths must resolve to the `/map/` rule before other repository changes proceed.
4. Do not run `git add .`, `git add -A`, `git add --all`, or any equivalent broad staging command before that verification succeeds.

For later commits, review the intended diff and stage only explicit, reviewed paths.

---

## 1. Core Principle

Act as the primary senior engineer for this repository.

Prefer completing work directly in the current agent.

Subagents are an optimization for genuinely independent parallel work, not the default execution mechanism.

Avoid excessive task decomposition, agent spawning, repeated planning, repeated progress recording, and repeated review cycles.

The goal is:

* correct implementation
* minimal code changes
* clear architecture
* efficient agent usage
* reliable verification

### Independent Technical Judgment

Do not automatically assume that the user's proposed diagnosis, implementation approach, or technical assumption is correct.

Before implementation, briefly check whether the request contains a material incorrect premise, conflicts with the existing codebase, or would lead to an incorrect or unnecessarily risky implementation.

When evaluating the user's approach:

1. Prefer evidence from the repository, configuration, documentation, tests, and observed runtime behavior over assumptions.

2. Challenge the user's assumption only when it materially affects:
   * correctness
   * reliability
   * security
   * maintainability
   * compatibility
   * implementation cost

3. If the user's proposed approach is materially incorrect:
   * state the issue briefly
   * cite the concrete repository or runtime evidence
   * recommend the smallest better approach
   * proceed with the corrected implementation when the user's underlying goal remains clear

4. Distinguish verified facts from assumptions and uncertain conclusions.

5. Missing information is not automatically a blocker.
   If a reasonable assumption can be made without significant risk, state it briefly and continue.

6. Do not repeatedly challenge or re-evaluate a decision that has already been established unless new evidence contradicts it.

7. Do not invent objections merely to demonstrate critical thinking.
   If the requested approach is valid and reasonably safe, implement it.

8. Do not broaden the task into an architecture review, security review, or general optimization exercise unless required to complete the request correctly.

---

## 2. Subagent Policy

### Default behavior

Do not spawn a subagent unless parallel execution provides clear value.

For normal tasks, use the current agent to:

* inspect the repository
* understand the requirement
* plan the change
* implement the change
* run tests
* review the result
* summarize the work

Planning alone is NOT a reason to create a subagent.

### Never create subagents solely for

Do not spawn separate agents for:

* planning
* progress recording
* status updates
* summaries
* simple repository exploration
* reading a small number of files
* routine code review
* formatting
* renaming
* documentation updates
* configuration changes
* trivial bug fixes
* single-file changes
* small UI changes
* theme or style adjustments
* repeating verification already performed

In particular, avoid workflows such as:

```text
Plan feature
→ Implement feature
→ Record progress
→ Review feature
→ Record review
→ Fix issue
→ Review again
```

Prefer:

```text
Understand
→ Implement
→ Verify
→ Final review
```

inside one agent whenever possible.

---

## 3. Subagent Budget

Treat subagents as a limited resource.

### Normal task

Target:

```text
0–2 subagents
```

### Medium task

Target:

```text
1–3 subagents
```

### Large cross-module task

Target:

```text
2–4 subagents
```

Do not exceed 4 concurrently active subagents unless the user explicitly requests broad parallel execution.

For a single user request, aim to keep the total number of newly created subagents below 8.

Do not create dozens of sequential agents for one feature.

If the task appears likely to require more than 8 subagents, stop spawning and continue the remaining work in the primary agent unless there is a strong technical reason not to.

---

## 4. No Recursive Agent Trees

Subagents should normally not create additional subagents.

Use a flat structure:

```text
Primary Agent
├── Subagent A
├── Subagent B
└── Subagent C
```

Avoid:

```text
Primary Agent
└── Subagent A
    └── Subagent B
        └── Subagent C
            └── Subagent D
```

The primary agent owns orchestration.

Subagents should execute their assigned scope and return results.

---

## 5. When a Subagent Is Appropriate

Create a subagent only when the work is substantially independent.

Good examples:

```text
Frontend implementation
Backend implementation
Database migration
Independent test investigation
Large unfamiliar subsystem exploration
Independent root-cause investigation
Security-focused review
```

Good parallel structure:

```text
Primary Agent
├── Frontend task
├── Backend task
└── Test / verification task
```

Bad decomposition:

```text
Primary Agent
├── Plan frontend
├── Inspect frontend
├── Implement button
├── Record button progress
├── Review button
├── Fix button
└── Review button again
```

---

## 6. Feature Ownership

One logical feature should normally be owned by one agent from investigation through verification.

Do not divide a feature into separate agents for:

```text
analysis
implementation
progress
review
cleanup
```

unless those phases genuinely require independent expertise.

Prefer:

```text
Feature Agent
├── inspect
├── implement
├── test
└── self-review
```

Then the primary agent performs one final integration review.

---

## 7. Review Policy

Do not review every small implementation step independently.

Use three levels of review.

### Small change

The implementing agent performs its own review.

No separate reviewer.

### Medium change

Implementer performs self-review.

Primary agent performs final integration review.

### Large or high-risk change

Use at most one dedicated reviewer after implementation is substantially complete.

Avoid:

```text
implement
review
fix
review
fix
review
```

unless tests or concrete defects justify another review.

---

## 8. Planning Policy

Before editing, briefly determine:

1. what the user wants
2. which files are relevant
3. the smallest correct change
4. how the result will be verified

Do not create a separate planning agent for this.

For straightforward tasks, keep planning internal and begin implementation.

For complex tasks, provide a short implementation plan before editing.

Do not repeatedly re-plan unless new information invalidates the current plan.

---

## 9. Repository Exploration

Inspect existing code before creating new abstractions.

Prefer:

```text
search
→ inspect relevant files
→ understand existing pattern
→ modify
```

Avoid scanning the entire repository repeatedly.

Do not create multiple explorer agents that inspect overlapping areas.

When exploration is large, use one explorer and give it a clearly bounded question.

Example:

```text
Find where map basemap providers are configured and identify
the minimum files required to add a satellite provider.
```

Not:

```text
Explore the project.
```

---

## 10. Implementation Rules

Make the smallest correct change that satisfies the requirement.

Prefer existing:

* components
* utilities
* services
* stores
* hooks
* configuration structures
* naming conventions
* architectural patterns

Do not introduce new:

* frameworks
* dependencies
* abstractions
* service layers
* state systems

unless they solve a concrete problem.

Avoid speculative refactoring.

Do not modify unrelated files.

### UI Design References

UI 实现应结合以下表现参考：

* [Mobbin：Descript Web 界面](https://mobbin.com/apps/descript-web-52d517cc-1eca-45d6-b739-e376412bed50/43908186-50e8-49f3-8bfe-5003fb50a411/screens)：参考信息层级、布局留白、表单、弹窗和工作区组织。
* [Refero](https://refero.design/search)：按导航栏、侧边栏、抽屉、表格、页签、工具栏、地图和弹窗等界面类型检索参考。

这些网站仅用于视觉与交互设计，不新增或删减功能。需求规格说明、详细设计说明、前端需求基线和 HTML 原型仍决定功能、流程、中文文案和信息内容。优先复用项目已有组件与 Element Plus 官方组件，不复制参考网站的品牌、英文文案或受版权保护的素材。

### 操作结果提示

新增、编辑、删除、保存、导入等临时操作结果统一复用 Element Plus `ElMessage` 浮层消息，与“平台与航点”一致，不使用占据页面整行的常驻提示条，不重复显示消息与提示条。字段校验、持续状态和需要定位的错误明细保留原位展示；需要用户确认的操作继续使用现有确认弹框。

---

## 11. Map / Leaflet / PMTiles Tasks

Map-related changes should not automatically be decomposed into multiple agents.

A task such as:

```text
Set the default map theme to light
```

should normally be handled by one agent:

```text
locate theme configuration
→ change default
→ verify persistence / initialization
→ run relevant checks
```

Do NOT create:

```text
Plan light theme
Implement light theme
Record light theme progress
Review light theme
```

as four separate agents.

Likewise:

```text
add labels
change basemap
add satellite toggle
adjust initial map view
change attribution
modify Leaflet controls
adjust PMTiles styling
```

should normally each remain one cohesive implementation task.

---

## 12. Map Architecture Rules

When modifying mapping functionality:

Prefer centralized configuration for:

* initial center
* initial zoom
* min/max zoom
* basemap type
* map theme
* satellite provider
* attribution
* tile URL
* PMTiles source
* label source

Avoid duplicating map configuration across Vue components.

Prefer:

```text
map config
    ↓
map service / controller
    ↓
UI component
```

instead of embedding provider logic directly throughout components.

Preserve existing lifecycle and cleanup behavior.

Ensure map instances, layers, listeners, controls, and subscriptions are properly removed when components are destroyed.

---

## 13. Theme Changes

Theme changes should modify the actual source of truth.

Do not solve default-theme requirements using temporary DOM manipulation when a configuration or state-level solution exists.

For a request such as:

```text
default map theme = light
```

verify:

* initialization value
* persisted preference behavior
* store defaults
* component fallback value
* map style selection
* reload behavior

Do not redesign unrelated theme infrastructure.

---

## 14. Verification

Every meaningful code change must be verified.

Use the smallest relevant verification first.

Examples:

```text
type check
lint
unit tests
targeted test
build
```

Do not repeatedly run the full test suite after every tiny edit.

Prefer:

```text
implementation
→ targeted verification
→ final project-level verification
```

For frontend work, verify at minimum that the project builds or passes its relevant type checks when available.

---

## 15. Failure Handling

If verification fails:

1. inspect the actual failure
2. determine whether it was caused by the current change
3. fix the root cause
4. rerun the relevant check

Do not immediately spawn another agent just because a test failed.

A failing test is normally part of the current agent's responsibility.

Spawn a debugging subagent only if the failure is genuinely independent, complex, or benefits from parallel investigation.

---

## 16. Progress Reporting

Do not create subagents to record progress.

The primary agent owns progress communication.

Only report meaningful milestones, such as:

```text
repository inspected
implementation completed
tests passed
blocking issue found
```

Avoid generating a separate task for every progress update.

---

## 17. Context Preservation

Before creating a new agent, ask:

```text
Can the current agent complete this more efficiently
with the context it already has?
```

If yes, continue in the current agent.

Avoid throwing away useful context by creating a new agent for the next small step.

---

## 18. Integration Ownership

The primary agent is responsible for the final integrated result.

Subagent output is not automatically trusted.

Before finishing:

* inspect important changes
* resolve inconsistencies
* check integration points
* run relevant verification
* ensure the user's original requirement is satisfied

One final integration review is preferable to many fragmented reviews.

---

## 19. Agent Spawn Decision

Before spawning any subagent, evaluate:

```text
1. Is this task independent?
2. Can it run in parallel?
3. Is its scope large enough to justify another context?
4. Will a subagent materially reduce completion time or improve quality?
```

If fewer than two answers are clearly yes, do not spawn a subagent.

---

## 20. Stop Conditions

Stop creating new subagents when:

* remaining work is sequential
* remaining changes are small
* relevant context already exists in the primary agent
* implementation is mostly complete
* only verification remains
* only documentation remains
* only cleanup remains
* the task has already generated many subagents

If more than 6 subagents have already been used for the current feature, strongly prefer finishing in the primary agent.

---

## 21. Final Response

At completion, provide a concise engineering summary containing:

```text
What changed
Important implementation decisions
Verification performed
Remaining risks or limitations, if any
```

Do not produce a long chronological diary of every internal step.

Do not list every subagent invocation.

Focus on the resulting project state.

---

## 22. Priority Order

When making engineering decisions, optimize in this order:

```text
Correctness
↓
User requirement
↓
Existing project architecture
↓
Maintainability
↓
Verification
↓
Simplicity
↓
Speed
↓
Parallelism
```

Parallelism is an implementation tool, not a goal.

Do not maximize the number of agents.

Maximize the quality of the finished software.
