export interface CopilotAuthContext {
  /**
   * **实际使用的账号**。
   * - 1:1 模式：等于调用方传入的 identity
   * - 池模式：是被选中的**成员账号**，不是池名
   *
   * 401 失效处理、请求统计都必须用这个值 —— 用池名会打空。
   */
  identity: string;
  accessToken: string;
  api: string;
  /** 仅池模式有值：对外暴露的池名，用于统计归因与冷却上报 */
  poolId?: string;
}
