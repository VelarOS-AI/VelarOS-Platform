import type { ValidateInput } from './validation.js'

export interface TypeScriptPluginOptions {
  syntaxValidator?: boolean;
}

export interface CommandValidatorOptions {
  id: string;
  command: string;
  args?: string[];
  fileExtensions?: string[];
  timeoutMs?: number;
  cwd?: string;
  when?: (input: ValidateInput) => boolean;
}
