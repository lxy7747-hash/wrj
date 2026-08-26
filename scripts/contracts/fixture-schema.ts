type JsonObject = Record<string, unknown>

const OPENAPI_SCHEMA_REF_PREFIX = '#/components/schemas/'
const JSON_SCHEMA_REF_PREFIX = '#/$defs/'

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rewriteSchemaReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteSchemaReferences)
  if (!isObject(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === '$ref'
        && typeof child === 'string'
        && child.startsWith(OPENAPI_SCHEMA_REF_PREFIX)) {
        return [key, `${JSON_SCHEMA_REF_PREFIX}${child.slice(OPENAPI_SCHEMA_REF_PREFIX.length)}`]
      }
      return [key, rewriteSchemaReferences(child)]
    }),
  )
}

export function buildDeterministicFixtureSchema(openApi: unknown): object {
  if (!isObject(openApi)
    || !isObject(openApi.components)
    || !isObject(openApi.components.schemas)
    || !isObject(openApi.components.schemas.DeterministicFixtures)) {
    throw new TypeError('OpenAPI components.schemas.DeterministicFixtures is required')
  }

  // Only schema-component references move: annotations and any non-schema references retain source semantics.
  return rewriteSchemaReferences({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/components/schemas/DeterministicFixtures',
    $defs: openApi.components.schemas,
  }) as object
}
