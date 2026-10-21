import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MAX_BODY,
  buildCommands,
  buildToastXml,
  clip,
  encodePowerShell,
  escapeXml,
} from "../src/platform.ts"

test("escapeXml 转义 XML 元字符", () => {
  assert.equal(escapeXml(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;")
})

test("clip 压平空白并截断超长文本", () => {
  assert.equal(clip("  a\n b\tc  ", 80), "a b c")
  const long = "x".repeat(MAX_BODY + 10)
  const clipped = clip(long, MAX_BODY)
  assert.equal(clipped.length, MAX_BODY)
  assert.ok(clipped.endsWith("…"))
})

test("clip 截断时不切开代理对（否则 Windows toast XML 会非法）", () => {
  const long = "a".repeat(MAX_BODY - 2) + "😀" + "尾巴".repeat(10)
  const clipped = clip(long, MAX_BODY)
  assert.ok(clipped.length <= MAX_BODY)
  assert.ok(clipped.endsWith("…"))
  assert.doesNotMatch(clipped, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
})

test("buildToastXml 包含标题与正文，并按需静音", () => {
  const xml = buildToastXml({ title: "✅ AiRoute", body: "会话完成：修登录 <bug>" }, true)
  assert.match(xml, /<text>✅ AiRoute<\/text>/)
  assert.match(xml, /会话完成：修登录 &lt;bug&gt;/)
  assert.doesNotMatch(xml, /<audio/)

  const silent = buildToastXml({ title: "t", body: "b" }, false)
  assert.match(silent, /<audio silent="true"\/>/)
})

test("encodePowerShell 输出可解码的 UTF-16LE base64", () => {
  const encoded = encodePowerShell("Write-Output '通知'")
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), "Write-Output '通知'")
})

test("Windows 用 cmd start 把 powershell 甩到独立进程，通知内容走环境变量", () => {
  const commands = buildCommands({ title: "✅ AiRoute", body: "会话完成" }, { platform: "win32", sound: true })
  assert.equal(commands[0]?.file, "cmd.exe")
  assert.deepEqual(commands[0]?.args.slice(0, 5), ["/c", "start", "", "/b", "powershell.exe"])
  assert.ok(commands[0]?.args.includes("-EncodedCommand"))
  assert.match(commands[0]?.env?.["OPENCODE_NOTIFY_XML"] ?? "", /会话完成/)
  assert.ok(commands[0]?.env?.["OPENCODE_NOTIFY_APP_ID"])
  // start 不可用时的兜底：直接调 powershell。
  assert.equal(commands[1]?.file, "powershell.exe")
})

test("macOS 用 argv 传值，不把文本拼进脚本", () => {
  const [command] = buildCommands({ title: '标题"', body: "正文'" }, { platform: "darwin", sound: true })
  assert.equal(command?.file, "osascript")
  assert.equal(command?.args.at(-1), '标题"')
  assert.equal(command?.args.at(-2), "正文'")
})

test("Linux 用 notify-send", () => {
  const [command] = buildCommands({ title: "t", body: "b" }, { platform: "linux", sound: true })
  assert.equal(command?.file, "notify-send")
  assert.deepEqual(command?.args.slice(-2), ["t", "b"])
})

test("未知平台没有可用命令", () => {
  assert.deepEqual(buildCommands({ title: "t", body: "b" }, { platform: "aix", sound: true }), [])
})
