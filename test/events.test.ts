import assert from "node:assert/strict"
import { test } from "node:test"
import type { V2Event } from "@opencode/client/promise"
import { createDeduper, createThrottle, describeEvent, isNotifyEvent, resetSharedState, sharedState } from "../src/events.ts"
import { defaults } from "../src/options.ts"

const idle = {
  id: "evt_1",
  created: 1,
  type: "session.idle",
  data: { sessionID: "ses_1" },
} satisfies V2Event

const succeeded = {
  id: "evt_2",
  created: 2,
  type: "session.execution.succeeded",
  durable: { aggregateID: "ses_1", seq: 1, version: 1 },
  data: { sessionID: "ses_1" },
} satisfies V2Event

const failed = {
  id: "evt_3",
  created: 3,
  type: "session.execution.failed",
  durable: { aggregateID: "ses_1", seq: 2, version: 1 },
  data: { sessionID: "ses_1", error: { type: "provider", message: "401 Unauthorized" } },
} satisfies V2Event

const form = {
  id: "evt_4",
  created: 4,
  type: "form.created",
  data: {
    form: {
      id: "form_1",
      sessionID: "ses_1",
      title: "选择部署环境",
      fields: [
        { key: "env", type: "string", title: "环境" },
        { key: "secret", type: "string", hidden: true },
      ],
    },
  },
} satisfies V2Event

const permission = {
  id: "evt_5",
  created: 5,
  type: "permission.asked",
  data: {
    id: "per_1",
    sessionID: "ses_1",
    action: "edit",
    resources: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
  },
} satisfies V2Event

const deps = (snapshot: { title?: string; parentID?: string; directory?: string } | undefined) => ({
  session: async () => snapshot,
})

test("isNotifyEvent 按配置放行各类事件", () => {
  assert.ok(isNotifyEvent(idle, defaults))
  assert.ok(isNotifyEvent(succeeded, defaults))
  assert.ok(isNotifyEvent(failed, defaults))
  assert.ok(isNotifyEvent(form, defaults))
  assert.ok(isNotifyEvent(permission, defaults))

  const off = { ...defaults, sessionFinished: false, formCreated: false, permissionAsked: false }
  assert.ok(!isNotifyEvent(idle, off))
  assert.ok(!isNotifyEvent(succeeded, off))
  assert.ok(!isNotifyEvent(failed, off))
  assert.ok(!isNotifyEvent(form, off))
  assert.ok(!isNotifyEvent(permission, off))
})

test("session.idle 用会话标题和项目名", async () => {
  const notification = await describeEvent(idle, deps({ title: "修登录跳转", directory: "/work/AiRoute" }))
  assert.deepEqual(notification, { title: "✅ AiRoute", body: "会话完成：修登录跳转" })
})

test("session.execution.succeeded 与 idle 文案一致", async () => {
  const notification = await describeEvent(succeeded, deps({ title: "修登录跳转", directory: "/work/AiRoute" }))
  assert.deepEqual(notification, { title: "✅ AiRoute", body: "会话完成：修登录跳转" })
})

test("session.execution.failed 带失败原因", async () => {
  const notification = await describeEvent(failed, deps({ directory: "/work/AiRoute" }))
  assert.deepEqual(notification, { title: "⚠️ AiRoute", body: "会话失败：401 Unauthorized" })
})

test("子会话结束不提醒", async () => {
  const snapshot = deps({ parentID: "ses_parent", directory: "/work/AiRoute" })
  assert.equal(await describeEvent(idle, snapshot), undefined)
  assert.equal(await describeEvent(succeeded, snapshot), undefined)
})

test("查不到会话时仍然提醒", async () => {
  const notification = await describeEvent(idle, deps(undefined))
  assert.deepEqual(notification, { title: "✅ opencode", body: "会话完成，等待你的下一步" })
})

test("会话查询抛错不影响提醒", async () => {
  const notification = await describeEvent(idle, {
    session: async () => {
      throw new Error("gone")
    },
  })
  assert.equal(notification?.title, "✅ opencode")
})

test("form.created 只列出可见字段", async () => {
  // 用 POSIX 路径：basename 是平台实现，Windows 反斜杠路径在 Linux/macOS 上不会被拆开。
  const notification = await describeEvent(form, deps({ directory: "/work/AiRoute" }))
  assert.deepEqual(notification, { title: "❓ AiRoute", body: "等待回答：选择部署环境（环境）" })
})

test("permission.asked 最多列 3 个资源", async () => {
  const notification = await describeEvent(permission, deps({ directory: "/work/AiRoute" }))
  assert.deepEqual(notification, {
    title: "🔐 AiRoute",
    body: "等待授权：edit（src/a.ts, src/b.ts, src/c.ts）",
  })
})

test("createDeduper 丢弃窗口内重复的 event id", () => {
  const dedupe = createDeduper(50)
  assert.ok(dedupe("evt_1"))
  assert.ok(!dedupe("evt_1"))
  assert.ok(dedupe("evt_2"))
})

test("createThrottle 按会话压窗口", () => {
  const throttle = createThrottle(50)
  assert.ok(throttle("ses_1"))
  assert.ok(!throttle("ses_1"))
  assert.ok(throttle("ses_2"))
})

test("createThrottle 用 durable seq 区分轮次", () => {
  const throttle = createThrottle(50)
  // 同一轮的 replay：同一 seq 再来一次要被压掉。
  assert.ok(throttle("ses_1", 1))
  assert.ok(!throttle("ses_1", 1))
  // 新一轮即使紧接着来，seq 变了也要提醒。
  assert.ok(throttle("ses_1", 2))
  // durable 通知之后紧跟的 idle（没有 seq）视为同一轮。
  assert.ok(!throttle("ses_1"))
})

test("createThrottle 的 idle 窗口过期后允许再次提醒", async () => {
  const throttle = createThrottle(20)
  assert.ok(throttle("ses_1"))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(throttle("ses_1"))
})

test("sharedState 在进程内共享，resetSharedState 后重建", () => {
  resetSharedState()
  const first = sharedState()
  assert.equal(sharedState(), first)
  resetSharedState()
  assert.notEqual(sharedState(), first)
})
