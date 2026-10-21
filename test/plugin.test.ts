import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import type { V2Event } from "@opencode/client/promise"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { Notification } from "../src/platform.ts"
import { resetSharedState } from "../src/events.ts"
import plugin, { start } from "../src/plugin.ts"
import entry from "../index.ts"

// 去重/节流状态是进程内共享的，用例之间要清掉，否则上一个用例的通知会压掉下一个。
beforeEach(() => resetSharedState())

interface FakeSession {
  readonly title?: string
  readonly parentID?: string
  readonly directory?: string
}

// 去重表在模块作用域（跨插件实例共享），同一个 event id 在 10 秒内只能提醒一次。
// 每个 harness 默认给事件 id 加前缀，避免不同用例之间互相压制；
// 需要验证“多实例收到同一事件”的用例传 shareIds=true。
let harnessSeq = 0

function harness(
  events: V2Event[],
  sessions: Record<string, FakeSession>,
  options: Record<string, unknown> = {},
  shareIds = false,
) {
  const prefix = shareIds ? "" : `h${harnessSeq++}:`
  const received: Notification[] = []
  const subscriptions = { aborted: false }
  const ctx = {
    options,
    event: {
      async *subscribe() {
        for (const event of events) yield { ...event, id: `${prefix}${event.id}` } as V2Event
        await new Promise((resolve) => setTimeout(resolve, 5))
        subscriptions.aborted = true
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions[sessionID]
        if (!session) throw new Error("session not found")
        return {
          title: session.title,
          parentID: session.parentID,
          location: { directory: session.directory ?? "/work/AiRoute" },
        }
      },
    },
  }
  const notifier = {
    notify: (notification: Notification) => received.push(notification),
    flush: async () => {},
  }
  const stop = start(ctx as unknown as Context, { notifier, log: () => {} })
  return { received, stop, subscriptions }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待通知超时")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const idleEvent = (id: string, sessionID = "ses_1", created = Date.now()): V2Event => ({
  id,
  created,
  type: "session.idle",
  data: { sessionID },
})

const succeededEvent = (id: string, sessionID = "ses_1", seq = 1): V2Event => ({
  id,
  created: Date.now(),
  type: "session.execution.succeeded",
  durable: { aggregateID: sessionID, seq, version: 1 },
  data: { sessionID },
})

const permissionEvent = (id: string, sessionID = "ses_1"): V2Event => ({
  id,
  created: Date.now(),
  type: "permission.asked",
  data: { id: "per_1", sessionID, action: "edit", resources: ["src/a.ts"] },
})

const unrelatedEvent = (id: string): V2Event => ({
  id,
  created: Date.now(),
  type: "tui.prompt.append",
  data: { text: "hi" },
})

test("入口默认导出符合 opencode 插件约定", () => {
  assert.equal(entry.id, "opencode-notify-plugin")
  assert.equal(typeof entry.setup, "function")
  assert.equal(entry, plugin)
})

test("会话完成时发通知", async () => {
  const { received, stop } = harness([idleEvent("evt_1")], { ses_1: { title: "修登录", directory: "/work/AiRoute" } })
  await waitFor(() => received.length === 1)
  assert.deepEqual(received[0], { title: "✅ AiRoute", body: "会话完成：修登录" })
  stop()
})

test("同一轮 idle 与 execution.succeeded 只提醒一次", async () => {
  const { received, stop } = harness([succeededEvent("evt_a"), idleEvent("evt_b")], { ses_1: { title: "修登录" } })
  await waitFor(() => received.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(received.length, 1)
  stop()
})

test("同一 event id 只发一次", async () => {
  const { received, stop } = harness([idleEvent("evt_dup"), idleEvent("evt_dup")], {
    ses_1: { title: "修登录" },
  })
  await waitFor(() => received.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(received.length, 1)
  stop()
})

test("插件启动前的历史事件不再提醒", async () => {
  const { received, stop } = harness([idleEvent("evt_old", "ses_1", Date.now() - 60_000)], { ses_1: { title: "旧会话" } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(received.length, 0)
  stop()
})

test("无关事件与关闭的事件类型不发通知", async () => {
  const enabled = harness([unrelatedEvent("evt_x")], { ses_1: {} })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(enabled.received.length, 0)
  enabled.stop()

  const disabled = harness([permissionEvent("evt_y")], { ses_1: {} }, { events: { permissionAsked: false } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(disabled.received.length, 0)
  disabled.stop()
})

test("会话查询失败时仍然提醒", async () => {
  const { received, stop } = harness([idleEvent("evt_1", "ses_missing")], {})
  await waitFor(() => received.length === 1)
  assert.deepEqual(received[0], { title: "✅ opencode", body: "会话完成，等待你的下一步" })
  stop()
})

test("同一事件被多个插件实例收到时只提醒一次", async () => {
  const event = idleEvent("evt_multi", "ses_1")
  const sessions = { ses_1: { title: "修登录" } }
  const first = harness([event], sessions, {}, true)
  const second = harness([event], sessions, {}, true)
  await waitFor(() => first.received.length + second.received.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(first.received.length + second.received.length, 1)
  first.stop()
  second.stop()
})

test("多实例下同一轮的 idle 与 execution.succeeded 也只提醒一次", async () => {
  // 事件被哪个实例拿到是竞态的：succeeded 和 idle 可能落在不同实例上，
  // 所以节流状态也必须跨实例共享，否则会各弹一条。
  const events = [succeededEvent("evt_shared_turn"), idleEvent("evt_shared_turn_idle")]
  const sessions = { ses_1: { title: "修登录" } }
  const first = harness(events, sessions, {}, true)
  const second = harness(events, sessions, {}, true)
  await waitFor(() => first.received.length + second.received.length >= 1)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(first.received.length + second.received.length, 1)
  first.stop()
  second.stop()
})

test("快速接连的两轮各提醒一次", async () => {
  const sessions = { ses_1: { title: "修登录" } }
  const { received, stop } = harness(
    [
      succeededEvent("evt_t1"),
      idleEvent("evt_t1_idle"),
      succeededEvent("evt_t2", "ses_1", 2),
      idleEvent("evt_t2_idle"),
    ],
    sessions,
  )
  await waitFor(() => received.length === 2)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(received.length, 2)
  stop()
})
