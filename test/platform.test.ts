import assert from "node:assert/strict"
import { test } from "node:test"
import {
  MACOS_SOUND,
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

// 通知只用来提醒，点击的唯一预期效果是把它关掉。加按钮或 launch 会让点击
// 变成有副作用的动作（拉进程、开链接），这里锁住，防止将来顺手加上。
test("buildToastXml 不带按钮与激活参数，点击只关闭", () => {
  const xml = buildToastXml({ title: "t", body: "b" }, true)
  assert.doesNotMatch(xml, /<actions/)
  assert.doesNotMatch(xml, /launch=/)
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
  const [silent] = buildCommands({ title: '标题"', body: "正文'" }, { platform: "darwin", sound: false })
  assert.equal(silent?.file, "osascript")
  assert.equal(silent?.args.at(-1), '标题"')
  assert.equal(silent?.args.at(-2), "正文'")

  const [loud] = buildCommands({ title: "t", body: "b" }, { platform: "darwin", sound: true })
  assert.equal(loud?.args.at(-1), MACOS_SOUND)
  assert.equal(loud?.args.at(-2), "t")
  assert.equal(loud?.args.at(-3), "b")
  // 有没有第三个参数决定响不响，脚本本身不变，方便对比。
  assert.deepEqual(loud?.args.slice(0, -3), silent?.args.slice(0, -2))
})

test("Linux 用 notify-send", () => {
  const [command] = buildCommands({ title: "t", body: "b" }, { platform: "linux", sound: true })
  assert.equal(command?.file, "notify-send")
  assert.deepEqual(command?.args.slice(-2), ["t", "b"])
})

test("未知平台没有可用命令", () => {
  assert.deepEqual(buildCommands({ title: "t", body: "b" }, { platform: "aix", sound: true }), [])
})
