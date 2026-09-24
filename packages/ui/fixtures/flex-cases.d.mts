export interface FlexCaseNode {
  style?: Record<string, unknown>
  children?: FlexCaseNode[]
}
export const CASES: { name: string; root: FlexCaseNode }[]
