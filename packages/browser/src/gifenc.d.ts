/** gifenc 无官方类型;这里只声明我们用到的窄面。 */
declare module 'gifenc' {
  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: number[][]
        delay?: number
        transparent?: boolean
        dispose?: number
      }
    ): void
    finish(): void
    bytes(): Uint8Array
  }

  interface GifencModule {
    GIFEncoder(): GifEncoderInstance
    quantize(rgba: Uint8ClampedArray | Uint8Array, maxColors: number): number[][]
    applyPalette(rgba: Uint8ClampedArray | Uint8Array, palette: number[][]): Uint8Array
  }

  // gifenc 是 esbuild 打的 CJS 包(getter 式导出),命名导入在 require-ESM 下拿不到;
  // 用默认导入取整个命名空间对象(GIFEncoder/quantize/applyPalette 都是它的属性)。
  const gifenc: GifencModule
  export default gifenc
}
