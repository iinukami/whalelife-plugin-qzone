# 第三方组件说明

本仓库的 AGPL-3.0-only 及附加条款仅适用于有权按这些条款授权的原创材料，
不改变依赖、运行时、模型、平台客户端或其他项目的许可。安装及分发时应保留
各依赖包内的 LICENSE、COPYING、NOTICE 等原文件，并履行其源码提供等义务。
本表列出直接运行依赖；传递依赖与具体版本以 package-lock.json 和包内声明为准。

| 运行依赖 | 许可声明（已安装版本） |
| --- | --- |
| `sharp` | `Apache-2.0` |

Sharp 的原生包还包含 libvips 等组件，涉及 LGPL-3.0-or-later 等许可；不能只用 Sharp 的 Apache-2.0 标签概括全部原生内容。以所分发平台包内的许可与来源信息为准。

本插件经 QQ 插件提供的服务访问平台。QQ 插件实际使用的 NapCat、Frida 与 QQ 客户端等组件
仍按各自条款使用；特别是 NapCat 4.18.41 的非商业条件不会因本仓库采用 AGPL 而消失。
见 [QQ 插件第三方说明](https://github.com/iinukami/whalelife-plugin-qq/blob/main/THIRD_PARTY_NOTICES.md)。
