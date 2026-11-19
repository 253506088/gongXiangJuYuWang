# Android 实际验证记录

## 大文件接收进度与主机断点分块（2026-11-19）

针对真实平板发送 2.4 GB / 2.1 GB MKV 时长期等待、接收端无动静的问题，Android 主机间转发改用自动 bootstrap 会话、`POST /api/uploads`、最多 4 MiB 的 `PUT` 分块和 `complete`。每块落盘并 sync 后才确认 offset，断块回滚到前一确认位置，64 位 size/offset 全程保留。发送端保存 peerUploadId，回执丢失后查询已确认 offset，暂停或重启后继续原任务；transferId 保证已完成回执丢失时不重复收件。旧匿名 `peer/receive` 仍兼容，并有接收进度。

接收任务创建时立即发系统进度通知与真实 WebView `linkwave-transfer` 事件，之后每秒更新来源、字节、百分比；首块、末块和状态变化即时更新。传输状态区分本机暂存 received 与接收端确认 deliveredBytes，并包含 phase。公共系统下载副本在后台保存，原生收件箱先通过同目录 rename 发布并立即确认 complete。上传临时文件移到应用外部收件目录下的 `.uploads`，避免多 GB 文件在完成前先跨卷复制一遍。后台保存用 saving 标志，完成时更新通知和 `linkwave-inbox-saved`；保存中不持有长时间 HostState 锁。服务停止中断旧 worker，重开恢复未完成的系统副本；已发布但元数据尚未更新的 MediaStore 行复用原 URI。

JDK 17 / SDK 35 / Gradle 8.14.3 release 实际编译，所有测试仅使用 `Mahjong_API30_Test` / `emulator-5580`。未连接、安装或修改真实平板或手机。

`node android/verify-bigfile.cjs` 全部通过，记录在 `verify-bigfile.log` / `verify-bigfile-result.json`：

- 64 MiB + 123 B 正式 APK 接收。零字节创建事件即从影音页定位到互传接收区；4 MiB 时真实 UI、原生事件和系统通知显示来源、4 MB / 64 MB、速度和 6%。截图 `preview-bigfile-progress.png`。
- 将第二块只发送 128 KiB 后断开，offset 保持 4 MiB；重传成功。确认 20 MiB 后强杀并重开应用，原 token、upload id、offset 保留，继续余下字节后收件箱和公共 `/sdcard/Download/邻波/` SHA-256 与源一致。
- 收件 complete 回执为 43 ms，随后公共副本异步保存；同 transferId 再创建与重复 complete 不产生第二份收件。
- 一个测试 `.part` 使用稀疏文件注入 2,147,483,771 字节的断点。正式 loader、PUT、RandomAccessFile seek、409 冲突的 offset 全部准确保留 long，没有完整传输 2 GB。另模拟已发布系统副本尚未更新元数据，恢复后保持相同 savedUri，不生成重复公共副本。
- Android 正式转发器发送 20 MiB + 57 B 到可控协议接收端，最大块 4 MiB。第一块已提交后故意丢失 HTTP 回执，通过 GET 查询断点恢复；再暂停并恢复，最终所有字节 SHA-256 一致，没有请求 legacy `peer/receive`。

`node android/verify-bigfile-interop.cjs` 调用正式 Node 和正式 Android 服务，64 MiB + 57 B 的 Windows→Android、Android→Windows 均通过 acknowledged deliveredBytes、最终收件箱 SHA-256；Android 的系统下载副本 SHA-256 也一致。记录在 `verify-bigfile-interop.log` / `verify-bigfile-interop-result.json`。模拟器到测试 Node 使用 adb reverse 绕过已定位的 API30 QEMU NAT 二进制丢字节问题，传输仍走正式主机 HTTP 协议。

`ANDROID_SMOKE_SERIALS=emulator-5580 node android/verify-direct-final-smoke.cjs` 验证新 release 的后台停止 HostService 后恢复原 Activity，同 serverId、旧收件箱保留；旧匿名 peer 接收、通知、公共副本、最终 CSS 与非 DEBUGGABLE flags 均通过，记录 `verify-bigfile-final-smoke.log`。既有测试已等待 saving=false 再验证公共副本，适配异步保存的正确时序。

最终 release `dist/邻波-LinkWave-Android.apk` 与 Gradle release 输出一致，SHA-256 `ece1f3e33913d4e55f33ee063b5beba15889a5abac0350a6e7c276fed1b3f127`；版本名 `1.2.0`、版本号 `3`。正式 APK 覆盖安装到模拟器后再次通过短 smoke。打包 app.js SHA-256 `368e3889bf9499bb8effbb58e092f138692e1c6814fac773a5d6c470f78e93a6`、styles.css `031b1a9713d5202e63d6aa7a4375f31dd88723f1c4f5d8f9a87b1d33f0866c62`，均与 public 相同。测试 Node 55987/55989 服务正常关闭；验证结束关闭唯一测试模拟器。

## 1.2.0 自有局域网免配对直连（2026-11-19）

JDK 17、Android SDK 35、Gradle 8.14.3 已实际编译 release APK，版本名 `1.2.0`、版本号 `3`、应用名“邻波”。两套独立无窗口 API 30 模拟器：`Mahjong_API30_Test` / `emulator-5580` 和 `Mahjong_API30` / `emulator-5582`；没有操作真实手机。以下结果来自正式 APK 的 Java HTTP 服务。

`node android/verify-direct.cjs` 的 Android 阶段已通过：

- 本机与 LAN Host 请求的 bootstrap 均自动返回 paired:true 与内部任务 token；同设备 id、同地址重连的 token 和 id 稳定；不返回配对码。LAN 会话没有本机管理权限。
- 匿名 state 可见公共收件、设备和共享；浏览器定向私收件不在公开清单中，匿名下载被拒绝；单文件链接清单、来源 URI、所有 token 均不公开。
- 匿名 `POST /api/peer/receive` 直接接收、落盘、返回 complete；匿名收件下载 SHA-256 一致。
- 两套 Android A→B、B→A，4 MiB 加尾块随机二进制通过正式 Java peer 流直接传送，全程无 pair 请求；发送端仅在对方确认后显示 complete。接收下载 SHA-256 一致。
- 每次接收自动发系统“收到文件”通知，并通过 MediaStore 自动保存到公共 `/sdcard/Download/邻波/<文件名>`；adb 检查公共文件 SHA-256 与发送源一致，全程没有点击下载或接收确认。应用专属 Download 目录保留可靠副本。`linkwave-inbox` WebView 事件由原生接收完成主动触发。

SAF 共享影音的 Android 独立阶段也已通过：A 的真实持久 SAF `LinkWaveSAF` 导出到公开 `/api/shared-library`，B 的 `state.shares` 自动出现 `{hostId,sourceName,remote:true}`。B 通过自身同源 `/api/peers/:hostId/shares/:shareId/browse|file` 读取 A 的真实 MP4；公开目录浏览、HEAD 长度和空响应体、Range 206 精确字节、越界 416、完整下载全部通过。实测文件 972478 字节，SHA-256 `d8bd23d3ac6bbd7a9932da20bc6e6cb3b1de3cc3a6ec722acdd440edfdcab063`。

模拟器网络限制已单独定位：两端 `/api/peers/connect` 使用 `http://10.0.2.2:55817`、`http://10.0.2.2:55819` 能正常校验 health、发现主机和浏览共享，但 API 30 QEMU 的 `10.0.2.2` 大文件下行路径重复出现中间单字节丢失，完整 MP4 声明 972478 字节而实收 972469–972472 字节；一次保存样本的丢失位置为 884159、892799、901439、910079、918719、927359、935999、953279（前七段间距 8640），尾部保持正确。A 直接导出的同一文件完整且正确。将 B 到 A 的 peer 地址改成 `http://127.0.0.1:55817`，并以 `adb -s emulator-5582 reverse tcp:55817 tcp:55817` 绕过 QEMU NAT后，同一 APK、同一路由完整返回 972478 字节且 SHA-256 一致。因此后续二进制和影音完整性验证使用 adb reverse，仍调用正式 Java host 互传与共享代理；没有用测试中继改写文件或修改服务协议。真实 Wi-Fi 的组播/广播和不同品牌后台保活仍须在真实设备环境另验，本次未操作真实手机。

1.2 的单文件 SAF 链接回归全部通过（`verify-file-links-direct.log` 与私有元数据过期阶段续跑的 `verify-file-links-direct-finish.log`）：真实 `ACTION_OPEN_DOCUMENT`、四种有效期、单文件能力边界、LAN 普通会话不能管理链接、匿名 4 MiB 加尾块 SHA-256、HEAD/三种 Range/416、友好名称与 query 不改变来源、准确下载数、重启持久 URI 授权、过期 410、撤销即时 404 与原文件不变、同一 document 路径替换后 device/inode 绑定返回 404/missing 均通过。过期验证仅在服务停止时通过模拟器 root 修改一个测试链接的 expiresAt，并由正式 loader/路由验证；首轮新启动 adbd 非 root 引起测试目录读取权限错误，提升该模拟器 adbd 后直接续跑过期、撤销与替换阶段，未重做已过的下载。测试的 LAN Host 请求改用 Node 原生 HTTP，因为 Node fetch 会归一化 Host；本机管理权限仍由请求 Host 与 remote IP 一起确定。

真实 API 30 WebView QA（`verify-direct-ui.cjs`，临时 debug APK 仅用于 CDP，交付 release 明确关闭调试）已验证：A 的正式 host 发送文件到 B，原生 `linkwave-inbox` 事件主动触发，B 从影音页自动切到互传页，醒目文件名通知、收件列表、未读角标、接收路径、系统通知和公共下载文件 SHA-256 同时正确，没有点击下载或接收确认。截图 `preview-direct-inbox.png`。

WebView 自动显示 A 的远端 `LinkWaveSAF` 并可打开文件。原 SDK MP4 是 H.264 High 4:4:4 Predictive / yuv444p / 465×892，API 30 浏览器不能解码，UI 正确显示格式错误。另存测试副本 `direct-playable.mp4`，由本地 ffmpeg 转成 H.264 baseline / yuv420p / 320×614 / 8 秒 / faststart，保留原始 MP4，不覆盖其 hash 样本。新副本 334927 字节，SHA-256 `de944eb8fea2717f2d5cdbd3c255f31bc6e5db3fc382faf121a398b575736bcf`。实测发现 API 30 不支持 `dvh` 而导致竖屏播放器高度过大，前端补充六处 `vh` fallback 后，最终 release APK 的真实 WebView 通过同源 peer 代理收到 206，实际解码为 320×614，currentTime 从 0.11 秒推进到 0.91 秒，seek 到 5.60 秒后继续到 6.04 秒，readyState=2、paused=false、error=null。标题、关闭按钮、视频进度条及字幕/下载页脚均位于 670 CSS 像素 viewport 内，竖屏截图 `preview-direct-video.png`。完整收件和影音 QA 在最终 release 上重新通过，截图 `preview-direct-inbox.png` 与 `verify-direct-ui-result.json` 来自交付 APK，未注入临时 CSS。API 30 的 `ro.debuggable=1` 开发系统镜像会为 release 暴露 WebView CDP，故最后利用该系统能力测交付 APK；APK 的 package flags 不含 DEBUGGABLE，源码在普通 release 调用 `setWebContentsDebuggingEnabled(false)`。

`ANDROID_DIRECT_STAGE=interop node android/verify-direct.cjs` 续跑 Windows 互通与跨主机共享阶段全部通过（`verify-direct-interop.log`），没有重做已完成的 Android 阶段：Windows 正式 Node host → Android、Android → Windows 均免 pair 请求传送 4 MiB 加尾块，发送端等待对方 complete 后完成，收件下载 SHA-256 一致，Android 系统通知和自动公共下载副本同时正确。A 的 SAF 共享自动出现在 B 与 Windows，两端匿名同源代理 browse、HEAD、Range 206/416、完整 SHA-256 和 download 的 attachment header 均正确。Windows 创建的本机媒体共享自动出现在 Android，匿名 peer 代理 HEAD/Range/完整 hash 正确。所有 `/api/shared-library` 只导出本机共享，未转发 remote 项而形成循环。测试创建的 Windows Node host 在 finally 正常关闭，测试端口 55917 已释放。

`node android/verify-direct-final-smoke.cjs` 在最终 release 两端通过：A 返回桌面后停止 HostService，再把原有 Activity 带回前台，服务自动启动，server id 不变、历史 inbox 保留；随后两端新的匿名文件均自动接收、公共下载 SHA-256 一致并发系统通知。API 30 `am stopservice` 在报告“Service stopped”时退出码为 255，测试按输出和 health 确认服务确已停止，未把此 shell 行为当作服务故障。真实包 HTTP 返回的 styles.css 与最终 public 文件 hash 相同，A 的截图 `preview-direct-release-inbox-emulator-5580.png` 记录了恢复后收到的文件。

最终 APK `dist/邻波-LinkWave-Android.apk` 与 release 输出相同，SHA-256 `fff34e1b60efa751c7f2fbe65e55cd7313275599c21882e70e5bec9d000c6dd7`；版本名 `1.2.0`、版本号 `3`、应用名“邻波”。打包源和 public 完全同步：app.js SHA-256 `c0bb5230deb9a33c147e92d52edf5ec14824ac0582eadf38d298c95cacedb3e5`，styles.css SHA-256 `22a55a8008f94acd46ed19b90fd308d040c81ed800184548a8df2543b4485cd7`。两端已重新覆盖最终 release，debug QA 包未作为最终安装状态保留。最后另存 heads-up 消失后的安静收件截图 `preview-direct-inbox-quiet.png`，以及暂停后原生播放键、0:06/0:08 与进度拖动条均可见的 `preview-direct-video-controls.png`。

验证结束后已关闭 `emulator-5580` 与 `emulator-5582`，两次 `emu kill` 均返回 OK，随后各自 `get-state` 返回设备不存在；测试 HTTP 映射端口 55817/55819 和测试 Windows host 55917 均无监听。最终 APK hash 未变。没有留下运行中的测试模拟器或测试 Node 服务，也没有操作真实手机。

## 1.1.0 单文件下载链接

2026-11-17，JDK 17、Android SDK 35、Gradle 8.14.3 实际编译 release APK，版本名 `1.1.0`、版本号 `2`；UDP 发现协议保持版本 `1`。覆盖安装到无窗口 `Mahjong_API30_Test` / `emulator-5580`（Android 11 / API 30），没有操作或安装到真实手机。

`ANDROID_TEST_SERIAL=emulator-5580 ANDROID_TEST_URL=http://127.0.0.1:55817 node android/verify-file-links.cjs` 全部通过。测试使用 adb 仅准备模拟器内的文件、操作其真实系统选择器和重启进程，下载请求访问 APK 内的正式 Java HTTP 服务。

- `POST /api/pick-file` 返回 `{pending:true}`，真实 `ACTION_OPEN_DOCUMENT` 选择单个文件，原上传选择器使用不同 requestCode。`state.pickedFile` 包含 URI、名称、字节数及新 selectionId，重启后没有 transient 选择信息。
- 系统持久 URI 授权记录为 `prefix=false, modeFlags=1`，只读授权在重启后保留。创建链接从原 URI 直接读取；创建前后接收箱和传输任务数量不变，没有上传或复制到主机接收目录。
- ID 是随机 32 位小写十六进制，公开 URL 使用第一个 LAN URL，不含会话 token。默认 24 小时、1 小时、7 天、手动撤销四种有效期正确；非法有效期、直接文件系统路径和目录 URI 均拒绝。
- 未配对客户端不能读取链接清单；普通配对客户端不能选择、创建、撤销或看到链接清单和来源 URI。
- 4 MiB 加尾块测试文件匿名完整下载 SHA-256 一致，响应是 attachment，并带 nosniff 和 sandbox CSP。HEAD 返回正确 Content-Length 和空响应体。修复了 NanoHTTPD 对 null HEAD 输入流将长度归零的行为。
- `bytes=4096-5119`、`bytes=-31`、`bytes=4194304-` 返回 206 和精确内容；越界返回 416 及 `Content-Range: bytes */size`。HEAD 和 Range 不计下载数，成功完整 GET 计数，重启后保留。
- 友好文件名或 `?path=` 不能改变读取来源；无效 ID 返回 404。
- 重启后匿名下载仍成功。过期返回 410，过期状态再次重启后仍保留。为避免等待 1 小时，测试仅在模拟器应用停止期间将一个测试链接的存储过期时间设为过去，随后由正式状态加载和下载路由验证。
- 撤销立即返回 404，SHA-256 验证原文件未变，重启后仍不可下载。将同一文档路径替换为另一文件后，原链接返回 404、管理清单显示 missing，底层 device/inode 身份绑定生效。

同一 APK 再次执行 `verify-emulator.cjs` 的完整既有协议回归并全部通过：二进制分块和 Range、Windows Node 与 Android 双向主机发送、PIN 和 Origin 保护、UDP 发现接收器、重启断点续传，以及既有只读 SAF 目录与路径穿越保护。

最终 API 30 WebView 的“链接分享”卡片截图是 `preview-file-links.png`。发现旧 WebView 缺少 `Element.replaceChildren`，共享前端补充兼容处理后重新打包。覆盖安装最终 APK，真实界面状态渲染正确；依次点击“创建下载链接”→“选择本机文件”→系统 SAF 选择→返回弹窗显示文件名和大小→“生成下载链接”成功，原生文件事件联动和隐藏 URI 输入均正确。截图为 `preview-file-link-dialog.png`、`preview-file-link-selected.png` 和 `preview-file-link-created.png`。对这条真实界面生成的链接再次匿名下载，SHA-256 一致，随后撤销返回 404。

最终 APK 已同步共享前端 assets，`public/app.js` 与打包源 assets 的 SHA-256 均为 `5aaf37920463eba4cae9979e1b12a96c984cd9af4f3ecacbd0f8f6119589782c`。APK SHA-256 为 `33b4942e101a7087e3c4a08d0df28bda90d2819bc5363688c52b0a61c1c61816`。验证结束后已关闭测试模拟器；没有留下运行中的 Android 测试服务。

网址清单按网卡优先级稳定排序：`wlan/wifi/eth/ap/swlan/p2p` 优先，其他接口居中，`rmnet/ccmni/tun/vpn` 后置，并保留全部可用 IPv4 地址。单文件 URL 和二维码都从排序后的首个地址生成。接口优先级静态检查确认 `eth0` 和 `wlan0` 优先、蜂窝与 VPN 仍保留；本次排序修改只重新编译 APK，未重开模拟器或重复已通过的协议测试。

2026-11-17，安装构建得到的 release APK，在 Android 11 / API 30 的两个独立模拟器实例运行。没有向任何真实手机安装软件。APK 使用开发测试签名。

`node android/verify-emulator.cjs` 全部通过：

- APK 启动，localhost 管理权限，64 位十六进制会话凭证。
- 自定义 Host 的 DNS rebinding 请求不会取得本机管理员 token。
- 外站 Origin 请求被拒绝。
- 使用已公开的设备 id 再次配对不会冒充原设备。
- 二维码 PNG 正确生成。
- 4 MiB 加尾块的随机二进制上传和接收箱下载，SHA-256 一致。
- Range `bytes=4096-5119` 返回 206、正确 Content-Range 和精确字节。
- 无关配对客户端不能删除公共接收箱内他人发送的文件。
- Windows Node 服务端 → Android 主机，PIN 配对、直接流式转发和最终下载 SHA-256 一致。
- Android 正式 UDP 接收器发现对等主机。
- Android 主机 → Windows Node 服务端，直接 Java HTTP 流式转发和最终下载 SHA-256 一致，中文发送者名称正确。
- 在确认 2048 字节上传后强制杀掉应用进程、重新启动，原会话凭证仍有效，偏移准确恢复，再上传余下字节后的 SHA-256 一致。
- 实际调用系统 SAF 目录选择器授权测试目录；进程重启后目录授权仍保留，浏览条目正确，视频 MIME 为 video/mp4，Range `512-1535` 精确返回测试字节，`../` 穿越路径返回 400。

`node android/verify-android-pair.cjs` 全部通过：

- 两套独立 APK 的 server id 不同。
- Android A → Android B，4 MiB 加尾块、PIN 配对、Android 服务直接向另一套 Android 服务发送文件，下载 SHA-256 一致。
- Android B → Android A 同样通过。该测试没有使用 Node 主机作为文件中继；Node 仅发送测试控制请求、产生测试数据并验证结果。

两个模拟器经 adb TCP 转发互通，UDP 公告使用 adb + 系统 netcat 注入正式 UDP 接收器，因为模拟器 Wi-Fi 地址为 10.0.2.16，而 emulator UDP redirection 目标为未启用的 10.0.2.15 接口。该限制属于模拟器 NAT；测试使用的是正式服务与正式文件传输协议。尚未在真实同网段 Wi-Fi 或不同品牌手机上验证组播/广播与后台保活行为。

UI 已在真实 API 30 WebView 截图检查；为旧 WebView 补充 CSS 定位属性后，移动导航正常显示在底部。截图：`preview-emulator.png`。

最终 APK 增加启动时清理 WebView HTTP 缓存，并将打包页面资源设为 `Cache-Control: no-store`。在已有旧版 CSS 缓存的第一套模拟器中覆盖安装最终 APK，没有清除应用数据；重新启动后底部导航恢复正确，会话与 SAF 目录仍保留。直接请求原生服务的 styles.css 验证 no-store，内容 SHA-256 为 `05729104bbc21c12a30a273116196588f662102f9987f87f285337123d5dc59d`。这次小修复已重新实际编译并截图复核。
