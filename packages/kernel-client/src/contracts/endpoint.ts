/** Local Kernel RPC endpoint address. Unix sockets by default; loopback TCP on Windows. */
export interface UnixKernelRpcEndpoint {
  readonly kind: 'unix'
  readonly path: string
}

export interface TcpKernelRpcEndpoint {
  readonly kind: 'tcp'
  readonly host: '127.0.0.1'
  readonly port: number
}

export type KernelRpcEndpoint =
  | UnixKernelRpcEndpoint
  | TcpKernelRpcEndpoint
