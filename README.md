# WhaleLife QQ 空间 插件

独立维护的 QQ 空间子插件：浏览动态、按需识图与查看视频画面、收藏选中图片、发表公开说说，以及白名单内点赞、评论、原创转发。运行 ID 保持 `qq/qzone`，使用父插件公开的 QQ 空间传输服务；本仓库不包含 QQ 登录、私聊、图库或主干实现。

## 配置与数据

- 初次自主使用开关关闭，互动白名单为空。关闭总开关后模型不能浏览、识图、发表或互动；管理页保留只读预览。
- 浏览可包含白名单外账号；点赞、评论、回复和提及受独立白名单约束。发表与转发固定所有人可见，只转发已确认原创内容。
- 普通浏览和识图只给当前轮模型，不存为未来记忆。实际动作保存回执；重复 actionId 不重发，不确定结果需查回执。
- 图库可选，明确收藏才交给图库；普通浏览不会自动收藏。缺少图库仍可浏览、识图和发表文字。
- 视频通过内置可选视觉接入提供，需要 QQ 的视频读取接口、视觉插件和宿主原生多模态工具。缺少其中一项只关闭视频；能力状态显示具体原因。原有图片识别继续沿用 QQ 已选看图模型。
- 数据保持在宿主 `plugins/qq/sub/qzone/data/`，分仓不改变 ID、页面路径或存储位置。升级只替换发行文件，保留 `data/`。
- 兼容旧版图库桥接的迁移脚本保留在 `scripts/qzone-gallery-migration.mjs`，目标仍是 QQ 安装目录，默认仅预览。

## 服务边界

通过已声明的 `qq` 服务使用登录所属账号的传输，不读取父插件文件或密钥。接口类型见 [src/types.ts](src/types.ts)。图库通过 `optionalDepends` 接入；父服务负责稳定兼容，缺少可选能力只禁用相应功能。

从空间 0.4.1 起，浏览翻页、读图、收藏或互动遇到原有引用错误时，可使用 QQ 0.14.4 提供的 `qzoneReferenceApiVersion: '1.0.0'` / `qzoneReferenceStatus` 查询当前状态。传入可信工具会话 ID 和对应的 post/cursor 类型，区分格式无效、无法校验、离线、账号变化、会话不匹配、真正过期和类型不符；只接收 v1 规定的固定提示，不回显任意服务错误。管理页翻页使用独立的预览会话。

诊断只供当轮反馈，不保存引用或诊断正文，不延长有效期、不重新浏览或重做互动。返回有效不能把刚才失败的操作算作成功；接口缺失、版本不支持、诊断失败或取消时继续使用原错误。旧版 QQ 无需同时升级。浏览/读图的一般失败提示检查连接或重新浏览，不要求不存在的动作 ID；发表、收藏和互动仍按已有动作回执核对，不确定结果不自动补做。

安装前准备 [QQ 插件](https://github.com/iinukami/whalelife-plugin-qq)，再将本项目 `dist/qzone/` 完整复制到宿主 `plugins/qq/sub/qzone/`。QQ 发行包的子插件声明已支持此位置。已有账号与数据无需迁移。

## 视频查看

空间 0.5.0 在内部通过 `optionalDepends: [gallery, vision]` / `ctx.optional('vision', ...)` 接入视觉服务，不产生新的子插件或桥接条目。仅当父 QQ 提供 `qzoneVideoApiVersion: '1.0.0'` / `qzoneReadVideo({sessionId,ref,index},{signal})`、视觉服务版本为 1.0.0 且视频组件和原生查看工具可用时开放视频读取。旧版 QQ 和旧宿主仍可使用原有能力。

`qzone_browse` 不自动下载视频。每条 `videoAccess` 显示可读取的序号或具体不可用原因；`hasVideo` 只代表检测到视频，`videoCount` 才代表父 QQ 在引用中封装了多少个支持的来源。检测到视频但没有可读取来源时，不伪称已看过。

从 0.5.1 起，页面状态和普通浏览使用视觉能力快照，在后台按需刷新（30 秒缓存，每次最多等待 5 秒）；首次检查显示“正在检查”，不会阻塞浏览或读图。视觉卸载立即撤销能力，重新绑定不沿用旧快照；真正打开视频时仍重新验证服务状态，缓存不能授权失效的视频读取。

模型按需调用 `qzone_open_video`，传本轮说说 `ref` 和从 0 开始的 `index`。空间用真实工具会话 ID 从 QQ 取得 MP4/WebM 原始字节，并交给视觉服务 `offerMedia`。返回 `prepared` 只表示准备完毕；随后调用 `vision_view(mediaRef)`，由当前聊天主模型接收真正的原生画面输入。可按时间段查看，或指定时刻、细节和裁剪补看；采样不等于逐帧观看，不包含音频。容量、格式、时长和采样限制遵守视觉服务的公开契约，空间单次接收不超过 64 MiB。

两个工具都使用宿主临时资料隔离：空间不保存视频、临时引用、描述或第三方正文；视觉插件只按自身短期引用规则暂存媒体。视频查看不受互动白名单限制，不触发收藏、点赞、评论或转发。关闭空间总开关会阻止新读取并取消在途读取；视觉停用或重载只撤销视频接入，不重载 QQ 或空间，不自动重试。

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

测试只使用模拟模型/平台和隔离目录，不使用个人账号或正式记忆。视频接入测试使用合成 MP4 和视觉插件的实际发行包，验证当前模型收到原生画面及资料不会进入后续轮次或持久存储；运行前需构建视觉包（含对应平台视频组件）。兼容测试覆盖当前宿主及既有最低宿主基线；运行测试前须保留宿主 Git 历史。

## 发布与隐私

源码仓库不包含个人配置、凭据、会话记忆、日志、数据库、第三方运行包、node_modules 或构建产物。`.gitignore` 已排除这些目录；提交前仍需检查变更。

## 许可证

本仓库原创代码采用 [GNU AGPL v3，仅限第 3 版（AGPL-3.0-only）](LICENSE)。带有相应文件声明的源码另适用 [第 7(b)、7(c) 条允许的合理署名及禁止歪曲来源条款](LICENSE-ADDITIONAL)。作者与来源见 [NOTICE.md](NOTICE.md)。

允许商业使用和收费。分发受许可覆盖的版本时，须按 AGPL 向接收者提供完整对应源码；修改版供用户通过网络交互时，须向这些用户显著提供免费获取该版本对应源码的入口。仅个人本机自用修改无需公开，也不要求向原作者提交 PR。具体权利义务以许可正文为准。

第三方依赖、模型与平台组件仍遵守各自许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)；本许可不授予它们的额外使用权。独立仓库或进程隔离是工程边界，并不自动决定插件在著作权上是否属于独立作品。
