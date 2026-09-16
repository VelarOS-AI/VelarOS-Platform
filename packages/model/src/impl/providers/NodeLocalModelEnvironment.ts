import {
  LocalModelEnvironment,
  type ModelEnvironmentVariables,
} from './LocalModelEnvironment'

/**
 * Node.js environment adapter.
 *
 * This is the only model-environment implementation that discovers
 * `process.env`, and it is exported exclusively from the `/node` entry.
 */
export class NodeLocalModelEnvironment extends LocalModelEnvironment {
  public readonly variables: ModelEnvironmentVariables

  constructor(variables: ModelEnvironmentVariables = process.env) {
    const snapshot = Object.freeze({ ...variables })
    super(snapshot)
    this.variables = snapshot
  }
}
