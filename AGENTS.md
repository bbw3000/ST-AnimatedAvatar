# AnimatedAvatar - an SillyTavern Extension

> 注：本文档使用中文撰写，技术术语和文件路径保持英文，以维持精准度避免歧言。

## 项目目标
- 为 SillyTavern 提供第三方动态头像扩展 `AnimatedAvatar`。
- 以角色卡内嵌配置为核心，直接把动态头像相关数据写入角色卡 `data.extensions.animated_avatar`。
- 动态头像来源仅限外部 URL 或插件自身资源，不依赖 ST 原生头像上传/裁切/转码链路。

## 当前实现边界
- 只做角色卡头像，不做 persona 独立系统配置。
- 不做本地文件上传、不做图床 API 接入、不做 WebP 帧提取/重编码。
- 默认静态头像使用原角色卡头像；不维护单独的默认静态/动态 WebP。
- 插件 UI 采用居中浮层，背景 blur，点击背景关闭。
- 窄屏判断沿用 ST 的单栏布局逻辑；窄屏时插件直接全屏显示。

## UI 约定
- UI 主体只保留动态头像设置，不再保留静态头像预览/切换面板。
- 动态头像预览保持 ST 风格的纵向矩形比例，严格 `2:3`，最大 `400px` 宽。
- 调整控件覆盖在头像预览图上，减少额外占位。
- `Scale`、`Offset X`、`Offset Y`、`Rotate`、`Brightness`、`Contrast`、`Saturation` 右侧都应有小型复位按钮。
- `Offset X/Y` 使用拉杆控制，范围 `0%–100%`，默认 `50%`。
- 控件区域默认隐藏；点击预览图片切换显示/隐藏，再次点击关闭。

## 渲染与样式约定
- 头像边框应挂在 `aa-avatar-frame` 上，内部 `img` 不应再显示 border。
- `aa-avatar-frame` 负责裁切与边框，内部 `img` 负责 `object-fit`、`object-position`、`transform`、`filter`。
- `scale`、`rotate`、`flip`、`brightness`、`contrast`、`saturate` 只作用于图片内容，不影响外框。
- 预览图使用 `position: absolute`，以 `top/left` 百分比控制偏移（基于 `Offset X/Y` 拉杆值），`transform` 中使用 `translate(-50%, -50%)` 做居中锚定。
- `Offset X/Y` 范围为 `0–100`，对应 `left/top` 的百分比值。默认 `50/50` 表示居中。
- 调整控制时不应重复重设 `img.src`，否则 animated WebP 会从头播放。

## 交互约定
- 聊天页头像入口：桌面端 hover 显示编辑按钮；移动端长按头像进入编辑。
- 头像放大逻辑会受到 ST 原生 zoom 行为影响，若需要修正外链 URL，需在插件中额外 patch zoomed avatar。
- `Remove` 必须真正删除角色卡中的 `data.extensions.animated_avatar`，并立即让页面回退到原角色卡静态头像。
- 保存后必须刷新当前角色卡内存态与聊天内已注册头像状态。

## 技术细节
- 角色卡保存优先使用 `/api/characters/merge-attributes` 做增量保存。
- 删除配置时使用完整角色卡保存流程，避免 `merge` 无法可靠删除字段。
- 读取聊天消息头像时，优先依据 `mesid -> context.chat[mesid]` 和消息中的 `original_avatar` / `force_avatar` 回溯角色。
- 消息头像渲染使用 `IntersectionObserver` 管理激活/停用：
  - 设置 `rootMargin: '300px 0px 300px 0px'` 作为安全缓冲区。
  - 头像进入缓冲区上方 300px 即开始加载 animated WebP，离开缓冲区下方 300px 才切回静态。
  - 避免在视口边缘附近高频切换导致 CPU 高消耗。
  - `threshold: 0`，只要有一个像素在扩展的根区域内即视为相交。
- 需要监听的 ST 事件至少包括 `CHAT_CHANGED`、`USER_MESSAGE_RENDERED`、`CHARACTER_MESSAGE_RENDERED`、`MESSAGE_UPDATED`、`MESSAGE_SWIPED`、`MORE_MESSAGES_LOADED`、`PERSONA_CHANGED`。

## 当前文件
- `manifest.json`：扩展注册信息。
- `index.html`：插件 UI 结构。
- `style.css`：窗口、预览、控件层、按钮、frame 样式。
- `index.js`：加载 UI、保存/删除、DOM patch、IntersectionObserver 缓冲激活、拉杆定位逻辑。

## 维护提示
- 任何涉及头像定位、裁切、缩放、旋转的修改，都要同步检查预览区与聊天区是否一致。
- 每次改动后建议至少检查：
  - `node --check data/default-user/extensions/AnimatedAvatar/index.js`
  - `git diff --check -- data/default-user/extensions/AnimatedAvatar`
- 不要依赖 ST 原生 avatar upload/edit 流程来保留 animated WebP。
- 不要把角色名或头像文件名当成最终唯一身份键；角色卡内配置才是第一优先级。
