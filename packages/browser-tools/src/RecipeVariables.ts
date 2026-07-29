export type BrowserRecipeRunVariables = Record<string, string>

export interface BrowserRecipeVariableResolution {
  resolvedInputs: Record<string, string>
  usedVariableNames: string[]
  unusedVariableNames: string[]
  missingVariableNames: string[]
}

const RecipeVariableTokenPattern = /%([A-Za-z_][A-Za-z0-9_-]*)%/g

function hasOwnVariable(
  variables: BrowserRecipeRunVariables,
  name: string
): boolean {
  return Object.prototype.hasOwnProperty.call(variables, name)
}

/** 把 recipe input 中的 %variableName% 占位符解析成执行时的真实值。 */
export function resolveBrowserRecipeInputVariables(
  inputs: Record<string, string>,
  variables: BrowserRecipeRunVariables = {}
): BrowserRecipeVariableResolution {
  const usedVariableNames = new Set<string>()
  const missingVariableNames = new Set<string>()
  const resolvedInputs: Record<string, string> = {}

  for (const [inputName, inputValue] of Object.entries(inputs)) {
    resolvedInputs[inputName] = inputValue.replace(
      RecipeVariableTokenPattern,
      (token, variableName: string) => {
        usedVariableNames.add(variableName)
        if (!hasOwnVariable(variables, variableName)) {
          missingVariableNames.add(variableName)
          return token
        }

        return variables[variableName]
      }
    )
  }

  return {
    resolvedInputs,
    usedVariableNames: [...usedVariableNames],
    unusedVariableNames: Object.keys(variables).filter(
      (variableName) => !usedVariableNames.has(variableName)
    ),
    missingVariableNames: [...missingVariableNames],
  }
}
