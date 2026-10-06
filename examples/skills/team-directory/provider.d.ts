/** 查询组织目录服务中的成员。
 * @OperationEffect none
 * @OperationModes execute
 */
export declare function search(input: {
  query: string
}): Promise<Array<{ name: string; email: string }>>
