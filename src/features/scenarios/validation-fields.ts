import type { ValidationIssue } from '../../contracts/domain-models'

/** 错误与警告均在字段下方展示；警告保持原有非阻断语义。 */
export function fieldValidationMessage(issues: readonly ValidationIssue[], fieldPath: string): string {
  const matches = issues.filter(issue => issue.fieldPath === fieldPath
    || issue.fieldPath.startsWith(`${fieldPath}.`) || issue.fieldPath.startsWith(`${fieldPath}[`))
  const issue = matches.find(issue => issue.severity === 'ERROR') ?? matches[0]
  return issue ? `${issue.severity === 'WARNING' ? '警告：' : ''}${issue.message}` : ''
}
