import fixtureSource from '../../frontend-technical-design-v1/contracts/deterministic-fixtures.json'
import type { DeterministicFixtureSet } from '../../src/contracts/domain-models.js'

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue)
  }

  return Object.freeze(value)
}

// The imported fixture is the immutable baseline; runtime owners receive only deep clones.
const fixtureBaseline = deepFreeze(
  fixtureSource as unknown as DeterministicFixtureSet,
)

export function loadFixtureProjection(): DeterministicFixtureSet {
  return structuredClone(fixtureBaseline)
}
