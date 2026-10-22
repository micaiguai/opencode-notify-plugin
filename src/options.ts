export interface Options {
  /** 一轮执行结束（成功或失败）。 */
  readonly sessionFinished: boolean
  readonly formCreated: boolean
  readonly permissionAsked: boolean
  readonly sound: boolean
  /** 通知留在屏幕上直到用户处理（macOS 无效）。 */
  readonly sticky: boolean
}

export const defaults: Options = {
  sessionFinished: true,
  formCreated: true,
  permissionAsked: true,
  sound: true,
  sticky: false,
}

/**
 * opencode 传进来的插件 options 是任意 JSON（未配置时为空对象）。
 * 这里只认白名单字段，类型不对就退回默认值，避免插件因配置写错而静默失效。
 */
export function parseOptions(raw: Readonly<Record<string, unknown>> | undefined): Options {
  const events = raw?.["events"]
  const eventOptions = events !== null && typeof events === "object" ? (events as Record<string, unknown>) : undefined

  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
  const eventFlag = (name: string, fallback: boolean) => flag(eventOptions?.[name], fallback)
  // sessionIdle 是旧字段名，保留兼容。
  const sessionFinished = eventFlag(
    "sessionFinished",
    flag(eventOptions?.["sessionIdle"], defaults.sessionFinished),
  )

  return {
    sessionFinished,
    formCreated: eventFlag("formCreated", defaults.formCreated),
    permissionAsked: eventFlag("permissionAsked", defaults.permissionAsked),
    sound: flag(raw?.["sound"], defaults.sound),
    sticky: flag(raw?.["sticky"], defaults.sticky),
  }
}
