import { spawn } from "node:child_process"
import { buildCommands, type CommandSpec, type Notification } from "./platform.ts"

export type Runner = (command: CommandSpec, timeoutMs: number) => Promise<boolean>

export interface NotifierOptions {
  readonly sound?: boolean
  readonly sticky?: boolean
  readonly platform?: NodeJS.Platform
  readonly run?: Runner
  readonly log?: (message: string, error?: unknown) => void
  readonly timeoutMs?: number
}

const defaultLog = (message: string, error?: unknown) => {
  console.error(`[opencode-notify-plugin] ${message}`, error ?? "")
}

/** 通知不参与 opencode 的主流程，失败一律吞掉并记一行日志。 */
export const spawnRunner: Runner = (command, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }

    const child = spawn(command.file, command.args, {
      stdio: "ignore",
      windowsHide: true,
      env: command.env ? { ...process.env, ...command.env } : process.env,
    })

    timer = setTimeout(() => {
      child.kill()
      finish(false)
    }, timeoutMs)

    child.once("error", () => finish(false))
    child.once("exit", (code) => finish(code === 0))
  })

export interface Notifier {
  readonly notify: (notification: Notification) => void
  /** 等待队列清空，测试和 preview 脚本用。 */
  readonly flush: () => Promise<void>
}

export function createNotifier(options: NotifierOptions = {}): Notifier {
  const platform = options.platform ?? process.platform
  const sound = options.sound ?? true
  const sticky = options.sticky ?? false
  const run = options.run ?? spawnRunner
  const log = options.log ?? defaultLog
  const timeoutMs = options.timeoutMs ?? 5_000

  let queue: Promise<void> = Promise.resolve()
  let warnedMissingCommand = false
  let warnedStickyUnsupported = false

  const deliver = async (notification: Notification) => {
    // macOS 没有让横幅驻留的 API，只能提示用户自己去改通知样式；说一次就够。
    if (sticky && platform === "darwin" && !warnedStickyUnsupported) {
      warnedStickyUnsupported = true
      log("macOS 无法让通知常驻：把「系统设置 → 通知 → 脚本编辑器」的样式改成「提醒」")
    }
    const commands = buildCommands(notification, { platform, sound, sticky })
    for (const command of commands) {
      if (await run(command, timeoutMs)) return
    }
    if (!warnedMissingCommand) {
      warnedMissingCommand = true
      log(`没有可用的系统通知命令（platform=${platform}）`)
    }
  }

  return {
    notify(notification) {
      // 串行执行：一次会话结束时可能连发多条，避免并发拉起多个进程。
      queue = queue.then(() => deliver(notification)).catch((error) => log("发送通知失败", error))
    },
    flush() {
      return queue
    },
  }
}
