import type { V2Event } from "@opencode/client/promise"
import type { Context, Plugin } from "@opencode/plugin/promise/plugin"
import { describeEvent, isCompletionEvent, isNotifyEvent, sharedState } from "./events.ts"
import { createNotifier, type Notifier } from "./notifier.ts"
import { parseOptions } from "./options.ts"

export interface StartOverrides {
  readonly notifier?: Notifier
  readonly log?: (message: string, error?: unknown) => void
}

/**
 * 订阅 opencode 的公共事件流，把「需要人看一眼」的事件转成系统通知。
 * 返回清理函数：opencode 卸载插件或退出时调用。
 */
export function start(ctx: Context, overrides: StartOverrides = {}): () => void {
  const log =
    overrides.log ?? ((message: string, error?: unknown) => console.error(`[opencode-notify-plugin] ${message}`, error ?? ""))
  const startedAt = Date.now()
  // 留 2 秒余量：事件可能在 setup 前后同一瞬间产生；更老的才当成历史回放。
  const staleBefore = startedAt - 2_000
  const options = parseOptions(ctx.options)
  const notifier = overrides.notifier ?? createNotifier({ sound: options.sound, log })
  // 每个 location 一个实例、都会收到全部事件，去重/节流状态必须跨实例共享，
  // 否则同一个事件会被每个实例各提醒一次。
  const { seen, throttle } = sharedState()
  const controller = new AbortController()

  const session = async (sessionID: string) => {
    const info = await ctx.session.get({ sessionID })
    return { title: info.title, parentID: info.parentID, directory: info.location.directory }
  }

  const handle = async (event: V2Event) => {
    // session.execution.* 是 durable 事件，重连时可能回放历史，别把昨天的事再弹一遍。
    if ("created" in event && typeof event.created === "number" && event.created < staleBefore) return
    if (!isNotifyEvent(event, options)) return
    if (!seen(event.id)) return
    if (isCompletionEvent(event)) {
      // 同一轮结束可能先来 durable 的 execution.* 再来 idle。durable 事件带 seq，用它认轮次；
      // idle 没有 seq，只能按会话压一个短窗口。
      const seq = "durable" in event ? event.durable.seq : undefined
      if (!throttle(event.data.sessionID, seq)) return
    }
    try {
      const notification = await describeEvent(event, { session })
      if (!notification) return
      notifier.notify(notification)
    } catch (error) {
      log(`处理事件 ${event.type} 失败`, error)
    }
  }

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        void handle(event)
      }
    } catch (error) {
      if (!controller.signal.aborted) log("事件订阅中断", error)
    }
  })()

  return () => controller.abort()
}

export default {
  id: "opencode-notify-plugin",
  setup: (ctx: Context) => start(ctx),
} satisfies Plugin
