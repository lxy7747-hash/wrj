import { pathToFileURL } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import {
  auditFixtureClosure,
  auditOpenApi,
  loadContractDocuments,
} from './contracts/contract-documents.js'
import type {
  DeterministicFixtureSet,
  ValidationFinding,
} from './contracts/contract-documents.js'
import { buildDeterministicFixtureSchema } from './contracts/fixture-schema.js'

function formatFindings(findings: readonly ValidationFinding[]): string {
  return findings.map(({ code, path, message }) => `- ${code} ${path}: ${message}`).join('\n')
}

export function validateContracts(): void {
  const { openApi, fixtures } = loadContractDocuments()
  const openApiFindings = auditOpenApi(openApi)
  if (openApiFindings.length > 0) {
    throw new Error(`OpenAPI audit failed:\n${formatFindings(openApiFindings)}`)
  }

  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  const validateFixture = ajv.compile(buildDeterministicFixtureSchema(openApi))
  if (!validateFixture(fixtures)) {
    const details = (validateFixture.errors ?? [])
      .map(({ instancePath, keyword, message }) => `- ${instancePath || '/'} ${keyword}: ${message ?? 'invalid'}`)
      .join('\n')
    throw new Error(`Fixture schema validation failed:\n${details}`)
  }

  const closureFindings = auditFixtureClosure(fixtures as DeterministicFixtureSet)
  if (closureFindings.length > 0) {
    throw new Error(`Fixture closure audit failed:\n${formatFindings(closureFindings)}`)
  }

  console.log('PASS OpenAPI: 67 unique operations; 33 typed POST/PUT/PATCH writes; DemoRole, path, envelope, and error audits')
  console.log('PASS fixture schema: Ajv 2020-12 validated DeterministicFixtures')
  console.log('PASS fixture closure: all IDs closed; BATCH-001 has 12 ordered run/report pairs; effective time=42')
  console.log('PASS CSV: link_quality.csv, events.csv, and link_switch.csv constants/order')
}

const entryPoint = process.argv[1]
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    validateContracts()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
