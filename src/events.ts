import { basename } from "node:path"
import type { V2Event } from "@opencode/client/promise"
import type { Options } from "./options.ts"
import type { Notification } from "./platform.ts"

/** 一轮执行结束：TUI 里是 session.idle，`opencode run` 里只有 execution.*。 */
export type CompletionEvent = Extract<
  V2Event,
  { type: "session.idle" | "session.execution.succeeded" | "session.execution.failed" }
>

export type NotifyEvent = CompletionEvent | Extract<V2Event, { type: "form.created" | "permission.asked" }>

export interface SessionSnapshot {
  readonly title?: string | undefined
  readonly parentID?: string | undefined
  readonly directory?: string | undefined
}

export interface EventDeps {
  readonly session: (sessionID: string) => Promise<SessionSnapshot | undefined>
}

export function isCompletionEvent(event: V2Event): event is CompletionEvent {
  return (
    event.type === "session.idle" ||
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed"
  )
}

export function isNotifyEvent(event: V2Event, options: Options): event is NotifyEvent {
  if (isCompletionEvent(event)) return options.sessionFinished
  switch (event.type) {
    case "form.created":
      return options.formCreated
    case "permission.asked":
      return options.permissionAsked
    default:
      return false
  }
}

/** 同一事件可能被多个 location 的插件实例收到，用它做去重。 */
export function createDeduper(ttlMs = 10_000, max = 500) {
  const seen = new Map<string, number>()

  const prune = (now: number) => {
    for (const [key, at] of seen) {
      if (now - at >= ttlMs) seen.delete(key)
    }
    if (seen.size > max) seen.clear()
  }

  return (id: string): boolean => {
    const now = Date.now()
    const previous = seen.get(id)
    if (previous !== undefined && now - previous < ttlMs) return false
    seen.set(id, now)
    if (seen.size > max) prune(now)
    return true
  }
}

/**
 * 同一轮结束可能先来 execution.succeeded 再来 idle（TUI 与 run 模式都会连发），
 * 按会话压一下窗口，避免一次对话弹两条。
 *
 * durable 事件带 `seq`，同一个 seq 一定是同一轮的重放；seq 变了就是新的一轮，
 * 因此快速连着的第二轮不会被误压掉。`session.idle` 没有 seq，只能和上一条通知
 * 按时间窗口比较，窗口内视为同一轮。
 */
export function createThrottle(ttlMs = 3_000, max = 500) {
  // sessionID -> 最后通知的 durable seq / 最后通知时间。
  const lastSeq = new Map<string, number>()
  const notifiedAt = new Map<string, number>()

  const prune = (now: number) => {
    for (const [sessionID, at] of notifiedAt) {
      if (now - at < ttlMs) continue
      notifiedAt.delete(sessionID)
      lastSeq.delete(sessionID)
    }
    if (notifiedAt.size > max) {
      notifiedAt.clear()
      lastSeq.clear()
    }
  }

  return (sessionID: string, seq?: number): boolean => {
    const now = Date.now()
    if (seq !== undefined) {
      if (lastSeq.get(sessionID) === seq) return false
      lastSeq.set(sessionID, seq)
      notifiedAt.set(sessionID, now)
      if (notifiedAt.size > max) prune(now)
      return true
    }
    const previous = notifiedAt.get(sessionID)
    if (previous !== undefined && now - previous < ttlMs) return false
    notifiedAt.set(sessionID, now)
    if (notifiedAt.size > max) prune(now)
    return true
  }
}

/**
 * 插件实例共享的去重/节流状态。
 *
 * opencode 为每个 location 各起一个插件实例，每个实例都会收到**全部**事件；
 * 而且每次加载都会重新求值模块（模块级变量不共享）。所以状态必须挂在 globalThis 上，
 * 让同进程内的所有实例共用一份，否则同一个事件会被每个实例各提醒一次。
 */
export interface SharedState {
  readonly seen: (id: string) => boolean
  readonly throttle: (sessionID: string, seq?: number) => boolean
}

const SHARED_KEY = "__opencodeNotifyPluginShared"

const globalStore = globalThis as unknown as Record<string, SharedState | undefined>

export function sharedState(): SharedState {
  return (globalStore[SHARED_KEY] ??= { seen: createDeduper(), throttle: createThrottle() })
}

/** 测试用：清掉进程内共享状态，避免用例之间互相压制。 */
export function resetSharedState(): void {
  delete globalStore[SHARED_KEY]
}

const projectName = (directory: string | undefined): string => {
  if (!directory) return "opencode"
  const name = basename(directory)
  return name || "opencode"
}

export async function describeEvent(event: NotifyEvent, deps: EventDeps): Promise<Notification | undefined> {
  const lookup = async (sessionID: string): Promise<SessionSnapshot | undefined> => {
    try {
      return await deps.session(sessionID)
    } catch {
      // 会话可能刚被删除；拿不到信息不影响提醒本身。
      return undefined
    }
  }

  switch (event.type) {
    case "session.idle":
    case "session.execution.succeeded": {
      const info = await lookup(event.data.sessionID)
      // 子会话（subagent）结束时也会触发，提醒父会话就够了。
      if (info?.parentID) return undefined
      const title = info?.title
      return {
        title: `✅ ${projectName(event.location?.directory ?? info?.directory)}`,
        body: title ? `会话完成：${title}` : "会话完成，等待你的下一步",
      }
    }

    case "session.execution.failed": {
      const info = await lookup(event.data.sessionID)
      if (info?.parentID) return undefined
      return {
        title: `⚠️ ${projectName(event.location?.directory ?? info?.directory)}`,
        body: `会话失败：${event.data.error.message}`,
      }
    }

    case "form.created": {
      const form = event.data.form
      const info = await lookup(form.sessionID)
      const fields = form.fields
        .filter((field) => !("hidden" in field && field.hidden === true))
        .map((field) => field.title ?? field.key)
        .filter(Boolean)
        .slice(0, 3)
      const detail = fields.length > 0 ? `（${fields.join(" / ")}）` : ""
      return {
        title: `❓ ${projectName(event.location?.directory ?? info?.directory)}`,
        body: `等待回答：${form.title}${detail}`,
      }
    }

    case "permission.asked": {
      const info = await lookup(event.data.sessionID)
      const resources = (event.data.resources ?? []).slice(0, 3).join(", ")
      const detail = resources ? `（${resources}）` : ""
      return {
        title: `🔐 ${projectName(event.location?.directory ?? info?.directory)}`,
        body: `等待授权：${event.data.action}${detail}`,
      }
    }
  }
}
