export class KernelSessionRunInterruptedError extends Error {
  public constructor() {
    super('Kernel session run interrupted before it acquired ownership')
    this.name = 'KernelSessionRunInterruptedError'
  }
}
