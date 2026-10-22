// 手动预览：直接发一条真实系统通知，用来确认当前机器的通知链路是否可用。
//   node scripts/preview.ts          # 会话完成
//   node scripts/preview.ts question # 等待回答
//   node scripts/preview.ts permission # 等待授权
// 末尾加 sticky 可以预览驻留模式（macOS 上无效，只会打一行提示）。
import { createNotifier } from "../src/notifier.ts"
import type { Notification } from "../src/platform.ts"

const samples: Record<string, Notification> = {
  idle: { title: "✅ Test", body: "会话完成：修复登录跳转" },
  question: { title: "❓ Test", body: "等待回答：选择部署环境（环境 / 版本）" },
  permission: { title: "🔐 Test", body: "等待授权：edit（src/a.ts, src/b.ts）" },
}

const kind = process.argv[2] ?? "idle"
const sample = samples[kind]
if (!sample) {
  console.error(`未知类型：${kind}，可选 ${Object.keys(samples).join(" / ")}`)
  process.exit(1)
}

const notifier = createNotifier({
  sound: true,
  sticky: process.argv.includes("sticky"),
  log: (message, error) => console.error(message, error ?? ""),
})
notifier.notify(sample)
await notifier.flush()
