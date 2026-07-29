declare const process: {
  argv: string[];
  cwd(): string;
  platform: string;
  exit(code?: number): never;
  exitCode?: number;
  env: Record<string, string | undefined>;
  stdout: { write(data: string): void };
  stderr: { write(data: string): void };
};
declare const console: { log(...args: any[]): void; error(...args: any[]): void; warn(...args: any[]): void };
declare class Buffer extends Uint8Array {
  public static isBuffer(value: unknown): value is Buffer;
  public static from(data: string | Uint8Array, encoding?: string): Buffer;
  public toString(encoding?: string): string;
}

declare module 'fs/promises' {
  export function readFile(path: any, options?: any): Promise<any>;
  export function writeFile(path: any, data: any, options?: any): Promise<void>;
  export function mkdir(path: any, options?: any): Promise<any>;
  export function readdir(path: any, options?: any): Promise<any[]>;
  export function stat(path: any): Promise<any>;
  export function lstat(path: any): Promise<any>;
  export function rename(oldPath: any, newPath: any): Promise<void>;
  export function rm(path: any, options?: any): Promise<void>;
  export function copyFile(src: any, dest: any): Promise<void>;
  export function access(path: any, mode?: any): Promise<void>;
}

declare module 'fs' {
  export function existsSync(path: any): boolean;
  export function readFileSync(path: any, options?: any): any;
  export function writeFileSync(path: any, data: any, options?: any): void;
}

declare module 'path' {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export function normalize(path: string): string;
  export function extname(path: string): string;
  export function basename(path: string): string;
  export const sep: string;
}

declare module 'crypto' {
  export function createHash(algorithm: string): any;
  export function randomUUID(): string;
}

declare module 'os' {
  export function tmpdir(): string;
}
