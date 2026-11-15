# WhaleLife QQ 空间 插件

独立维护的 QQ 空间子插件：浏览动态、按需识图与查看视频画面、收藏选中图片、发表公开说说，以及白名单内点赞、评论、原创转发。运行 ID 保持 `qq/qzone`，使用父插件公开的 QQ 空间传输服务；本仓库不包含 QQ 登录、私聊、图库或主干实现。

WhaleLife 交流 QQ 群：**962935021**

## 配置与数据

- 初次自主使用开关关闭，互动白名单为空。关闭总开关后模型不能浏览、识图、发表或互动；管理页保留只读预览。
- 浏览可包含白名单外账号；点赞、评论、回复和提及受独立白名单约束。发表与转发固定所有人可见，只转发已确认原创内容。
- 浏览、识图和视频工具的原始资料仅供当轮模型使用，不自动写入记忆；普通聊天中实际对用户说出的最终回复正常保存，包括其中的引用。实际动作保存回执；重复 actionId 不重发，不确定结果需查回执。
- 图库可选，明确收藏才交给图库；普通浏览不会自动收藏。缺少图库仍可浏览、识图和发表文字。
- 视频通过内置可选视觉接入提供，需要 QQ 的视频读取接口、视觉插件和宿主原生多模态工具。缺少其中一项只关闭视频；能力状态显示具体原因。原有图片识别继续沿用 QQ 已选看图模型。
- 数据保持在宿主 `plugins/qq/sub/qzone/data/`，分仓不改变 ID、页面路径或存储位置。升级只替换发行文件，保留 `data/`。
- 兼容旧版图库桥接的迁移脚本保留在 `scripts/qzone-gallery-migration.mjs`，目标仍是 QQ 安装目录，默认仅预览。

从 0.5.2 起，收藏成功但完成回执保存失败时，`saved/confirmed` 仍表示图库已确认收藏，`persistenceError: true` 表示这份结果尚未可靠落盘。当前进程中的查询（含哈希动作 ID）和重复请求持续保留该警告；查询不补写记录，重复请求不重新收藏。重启后若只剩 `pending` 记录，则保守返回 `uncertain`，不能据此自动重做。成功保存的回执不再由内存副本遮盖。

## 服务边界

通过已声明的 `qq` 服务使用登录所属账号的传输，不读取父插件文件或密钥。接口类型见 [src/types.ts](src/types.ts)。图库通过 `optionalDepends` 接入；父服务负责稳定兼容，缺少可选能力只禁用相应功能。

从空间 0.4.1 起，浏览翻页、读图、收藏或互动遇到原有引用错误时，可使用 QQ 0.14.4 提供的 `qzoneReferenceApiVersion: '1.0.0'` / `qzoneReferenceStatus` 查询当前状态。传入可信工具会话 ID 和对应的 post/cursor 类型，区分格式无效、无法校验、离线、账号变化、会话不匹配、真正过期和类型不符；只接收 v1 规定的固定提示，不回显任意服务错误。管理页翻页使用独立的预览会话。

诊断工具结果只供当轮反馈，不把原始引用或诊断正文写入工具档案；模型在普通聊天中实际说出的诊断解释仍作为聊天回复保存。诊断不延长有效期、不重新浏览或重做互动。返回有效不能把刚才失败的操作算作成功；接口缺失、版本不支持、诊断失败或取消时继续使用原错误。旧版 QQ 无需同时升级。浏览/读图的一般失败提示检查连接或重新浏览，不要求不存在的动作 ID；发表、收藏和互动仍按已有动作回执核对，不确定结果不自动补做。

保存边界遵循宿主现行临时工具契约：工具原文、临时引用、媒体字节、后续工具参数及检索 query 不自动写入历史、事件或日志，临时上下文中的事实写入仍受限制。普通 Web/QQ 聊天及 `sessions.run/enqueue` 的最终助手正文正常保留，可参与后续上下文；这不表示整个工具返回值被保存。明确使用 `runTransient/enqueueTransient` 的技术执行不保存临时输入，调用临时工具后的最终正文也不自动持久化。详见宿主 [临时工具内容与持久回执](https://github.com/iinukami/whalelife/blob/main/architecture/PLUGINS.md#临时工具内容与持久回执)。

安装前准备 [QQ 插件](https://github.com/iinukami/whalelife-plugin-qq)，再将本项目 `dist/qzone/` 完整复制到宿主 `plugins/qq/sub/qzone/`。QQ 发行包的子插件声明已支持此位置。已有账号与数据无需迁移。

## 视频查看

空间 0.5.0 在内部通过 `optionalDepends: [gallery, vision]` / `ctx.optional('vision', ...)` 接入视觉服务，不产生新的子插件或桥接条目。仅当父 QQ 提供 `qzoneVideoApiVersion: '1.0.0'` / `qzoneReadVideo({sessionId,ref,index},{signal})`、视觉服务版本为 1.0.0 且视频组件和原生查看工具可用时开放视频读取。旧版 QQ 和旧宿主仍可使用原有能力。

`qzone_browse` 不自动下载视频。每条 `videoAccess` 显示可读取的序号或具体不可用原因；`hasVideo` 只代表检测到视频，`videoCount` 才代表父 QQ 在引用中封装了多少个支持的来源。检测到视频但没有可读取来源时，不伪称已看过。

从 0.5.1 起，页面状态和普通浏览使用视觉能力快照，在后台按需刷新（30 秒缓存，每次最多等待 5 秒）；首次检查显示“正在检查”，不会阻塞浏览或读图。视觉卸载立即撤销能力，重新绑定不沿用旧快照；真正打开视频时仍重新验证服务状态，缓存不能授权失效的视频读取。

模型按需调用 `qzone_open_video`，传本轮说说 `ref` 和从 0 开始的 `index`。空间用真实工具会话 ID 从 QQ 取得 MP4/WebM 原始字节，并交给视觉服务 `offerMedia`。返回 `prepared` 只表示准备完毕；随后调用 `vision_view(mediaRef)`，由当前聊天主模型接收真正的原生画面输入。可按时间段查看，或指定时刻、细节和裁剪补看；采样不等于逐帧观看，不包含音频。容量、格式、时长和采样限制遵守视觉服务的公开契约，空间单次接收不超过 64 MiB。

两个工具都使用宿主临时资料隔离：空间不保存原始视频、媒体引用或工具返回的第三方正文；视觉插件按自身短期引用规则暂存媒体。模型在普通聊天中对用户说出的画面描述按聊天历史保留，媒体字节和原生画面输入不会自动进入后续轮次。视频查看不受互动白名单限制，不触发收藏、点赞、评论或转发。关闭空间总开关会阻止新读取并取消在途读取；视觉停用或重载只撤销视频接入，不重载 QQ 或空间，不自动重试。

父 QQ 的视频读取接口是新增可选能力，不能要求旧 QQ 改变既有行为。当前接入的最小契约见 [src/types.ts](src/types.ts)；空间本身不解析腾讯登录态或自行执行媒体下载。只有来源插件实际实现该接口，正式环境才具备空间视频读取能力。

## 开发与构建

需要 Node.js 24.22.1 或更新版本、Git。宿主与插件采用同级独立仓库，宿主只用于公开类型与隔离测试，不复制进插件发行包。示例从同一个空父目录开始：

```sh
git clone https://github.com/iinukami/whalelife.git
cd whalelife
npm ci
cd ..
git clone https://github.com/iinukami/whalelife-plugin-qq.git
cd whalelife-plugin-qq
npm ci --ignore-scripts
npm run build
cd ..
git clone https://github.com/iinukami/whalelife-plugin-gallery.git
cd whalelife-plugin-gallery
npm ci --ignore-scripts
npm run build
cd ..
git clone https://github.com/iinukami/whalelife-plugin-vision.git
cd whalelife-plugin-vision
npm ci --ignore-scripts
npm run build
cd ..
git clone https://github.com/iinukami/whalelife-plugin-qzone.git
cd whalelife-plugin-qzone
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

构建脚本固定从自身所在源码仓库读取输入，使用独占空白暂存目录和源码 `package-lock.json` 的版本/完整性记录，通过 `npm ci --omit=dev --ignore-scripts` 安装运行依赖。产物文件白名单、依赖版本和法律文件验证通过后，生成 `BUILD.json`（文件清单、大小、SHA-256 和源码锁摘要），再替换本仓库的 `dist/qzone/`。构建失败保留上一份产物；复用构建不继承旧 `data/` 或废弃入口。该操作只用于开发输出，不能用于清理正式插件目录或用户数据。输出目录是链接或另一个构建持有锁时会拒绝执行；进程被强制结束留下锁时须先核实原构建已退出，不能自动抢锁。

测试只使用模拟模型/平台和隔离目录，不使用个人账号或正式记忆。保存边界测试分别覆盖普通聊天与技术执行：前者保留最终回复及明确说出的引用，后者继续隔离临时输入和最终正文；两者都检查原始工具资料、媒体和后续参数的隔离，以及事实写入限制。QQ 投递同时检查临时发送工具不保存正文、正常回复可保留及重载去重。视频接入测试使用合成 MP4 和视觉插件的实际发行包，验证当前模型收到原生画面，下一轮仅保留允许保存的聊天回复，不携带视频字节、临时引用或原生帧；运行前需构建视觉包（含对应平台视频组件）。兼容测试覆盖当前宿主及既有最低宿主基线；运行测试前须保留宿主 Git 历史。

## 发布与隐私

源码仓库不包含个人配置、凭据、会话记忆、日志、数据库、第三方运行包、node_modules 或构建产物。`.gitignore` 已排除这些目录；提交前仍需检查变更。
