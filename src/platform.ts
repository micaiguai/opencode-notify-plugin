export interface Notification {
  readonly title: string
  readonly body: string
}

export interface CommandSpec {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export interface BuildOptions {
  readonly platform: NodeJS.Platform
  readonly sound: boolean
}

export const MAX_TITLE = 80
export const MAX_BODY = 240

// Windows PowerShell 在开始菜单里注册过的 AUMID。用它创建 toaster，
// 系统才会把通知真正投递到操作中心；随便拼一个 AUMID 会被静默丢弃。
const WINDOWS_APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`

// 通过 -EncodedCommand 传入，脚本里不要出现反引号或 ${，避免和 TS 模板字符串冲突。
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$document = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$document.LoadXml($env:OPENCODE_NOTIFY_XML)",
  "$toast = New-Object Windows.UI.Notifications.ToastNotification $document",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:OPENCODE_NOTIFY_APP_ID).Show($toast)",
].join("\n")

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&apos;"
    }
  })
}

/** 通知里不该出现换行和超长文本，否则 toast 会被裁得很难看。 */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  // 按码点边界截断：直接 slice 可能把 emoji 的代理对切成两半，
  // 半个代理对进 XML 会让 XmlDocument.LoadXml 抛错，整条通知都发不出去。
  let out = ""
  for (const char of flat) {
    if (out.length + char.length > max - 1) break
    out += char
  }
  return `${out}…`
}

export function buildToastXml(notification: Notification, sound: boolean): string {
  const title = escapeXml(clip(notification.title, MAX_TITLE))
  const body = escapeXml(clip(notification.body, MAX_BODY))
  const audio = sound ? "" : '<audio silent="true"/>'
  return (
    '<toast activationType="foreground">' +
    '<visual><binding template="ToastGeneric">' +
    `<text>${title}</text><text>${body}</text>` +
    "</binding></visual>" +
    audio +
    "</toast>"
  )
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64")
}

export function buildCommands(notification: Notification, options: BuildOptions): CommandSpec[] {
  switch (options.platform) {
    case "win32": {
      const args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(POWERSHELL_SCRIPT),
      ] as const
      const env = {
        OPENCODE_NOTIFY_XML: buildToastXml(notification, options.sound),
        OPENCODE_NOTIFY_APP_ID: WINDOWS_APP_ID,
      }
      // 用 cmd 的 start 把 powershell 甩到独立进程：`opencode run` 一轮结束后立刻退出，
      // 直接 spawn 的子进程会被一起回收，toast 还没弹出来就没了。
      // 第二条是 start 不可用时的兜底路径，通常不会走到。
      return [
        { file: "cmd.exe", args: ["/c", "start", "", "/b", "powershell.exe", ...args], env },
        { file: "powershell.exe", args, env },
      ]
    }
    case "darwin":
      // 用 argv 传值，避免把标题拼进 AppleScript 源码里做转义。
      return [
        {
          file: "osascript",
          args: [
            "-e",
            "on run argv",
            "-e",
            "display notification (item 1 of argv) with title (item 2 of argv)",
            "-e",
            "end run",
            clip(notification.body, MAX_BODY),
            clip(notification.title, MAX_TITLE),
          ],
        },
      ]
    case "linux":
      return [
        {
          file: "notify-send",
          args: [
            "-a",
            "opencode",
            "-u",
            "normal",
            clip(notification.title, MAX_TITLE),
            clip(notification.body, MAX_BODY),
          ],
        },
      ]
    default:
      return []
  }
}
