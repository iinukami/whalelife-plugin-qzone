# WhaleLife QQ 空间 插件

独立维护的 QQ 空间子插件：浏览动态、按需识图、收藏选中图片、发表公开说说，以及白名单内点赞、评论、原创转发。运行 ID 保持 `qq/qzone`，使用父插件公开的 QQ 空间传输服务；本仓库不包含 QQ 登录、私聊、图库或主干实现。

## 配置与数据

- 初次自主使用开关关闭，互动白名单为空。关闭总开关后模型不能浏览、识图、发表或互动；管理页保留只读预览。
- 浏览可包含白名单外账号；点赞、评论、回复和提及受独立白名单约束。发表与转发固定所有人可见，只转发已确认原创内容。
- 普通浏览和识图只给当前轮模型，不存为未来记忆。实际动作保存回执；重复 actionId 不重发，不确定结果需查回执。
- 图库可选，明确收藏才交给图库；普通浏览不会自动收藏。缺少图库仍可浏览、识图和发表文字。视频暂不识别。
- 数据保持在宿主 `plugins/qq/sub/qzone/data/`，分仓不改变 ID、页面路径或存储位置。升级只替换发行文件，保留 `data/`。
- 兼容旧版图库桥接的迁移脚本保留在 `scripts/qzone-gallery-migration.mjs`，目标仍是 QQ 安装目录，默认仅预览。

## 服务边界

通过已声明的 `qq` 服务使用登录所属账号的传输，不读取父插件文件或密钥。接口类型见 [src/types.ts](src/types.ts)。图库通过 `optionalDepends` 接入；父服务负责稳定兼容，缺少可选能力只禁用相应功能。

安装前准备 [QQ 插件](https://github.com/iinukami/whalelife-plugin-qq)，再将本项目 `dist/qzone/` 完整复制到宿主 `plugins/qq/sub/qzone/`。QQ 发行包的子插件声明已支持此位置。已有账号与数据无需迁移。

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
git clone https://github.com/iinukami/whalelife-plugin-qzone.git
cd whalelife-plugin-qzone
npm ci --ignore-scripts
npm run build
npm run check
npm test
```

测试只使用模拟模型/平台和隔离目录，不使用个人账号或正式记忆。兼容测试覆盖当前宿主及既有最低宿主基线；运行测试前须保留宿主 Git 历史。

## 发布与隐私

源码仓库不包含个人配置、凭据、会话记忆、日志、数据库、第三方运行包、node_modules 或构建产物。`.gitignore` 已排除这些目录；提交前仍需检查变更。

## 许可证

许可证待确定，当前仓库未添加项目许可证。第三方依赖沿用各自许可证。
