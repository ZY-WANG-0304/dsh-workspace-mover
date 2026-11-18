# Workspace mover

把会话从一个工作区移动到另一个工作区，或移回「未分组」。两种操作方式：

- **会话行菜单**：会话行右侧 `⋯` →「移动到工作区…」→ 选择目标工作区（或「移出工作区」）。
- **拖拽**：把会话行拖到侧栏里另一个工作区的分组上（标题行或其下任意位置）松开；拖到「未分组」分组则移出工作区。拖拽过程中会显示目标工作区名称的提示。

## 行为

- 只有侧栏里的归属关系变化：会话日志、历史、文件、正在运行的回合与后台任务都不受影响。
- 移动后的会话由目标工作区记账，出现在该分组的列表顶部；原工作区分组不再包含它。
- 归档、置顶、排序、Fork 仍走 DSH 自己的逻辑：归档是全局的，Fork 会跟随源会话当前的归属。
- 侧栏会在移动后立即刷新——更新来自 DSH 自己的 `workspace/follow` 流，插件不另行绘制列表。

## 实现与限制

DSH 把工作区归属绑定在不可变的 `SessionHeader.cwd` 上：工作区记录里的会话 id 在每次读取和写入时都会与工作区路径做一次规范 cwd 校验，所以「cwd 与工作区目录不同」的会话无法被另一个工作区记账。因此本插件：

1. 在 `<DSH_HOME>/storages/workspace-mover.json` 里持久保存 `sessionId → workspaceId` 的重新归属表——**只保存 cwd 与目标目录不同的会话**：cwd 恰好等于工作区目录的会话插入记录后由 DSH 原生校验维持，不需要归属表（启动时会把这类冗余条目录清理掉）；
2. 运行时包住工作区注册表的两个内部接缝——候选校验（`candidateMatches`）与会话挂载校验（`attachSession`）——让重新归属的会话在读写与重启后仍然留在目标工作区；
3. 通过 `plugin` 自有的 HTTP 路由（`/workspace-mover/state`、`/workspace-mover/move`）接受浏览器侧的请求，路由与 DSH 其他插件路由一样经过 `connection.requestRejection` 的同源/身份校验。

限制：

- 上述两个接缝是 DSH 的内部结构，不是公开 API。DSH 升级后如果结构变化，插件会在日志里说明并保持不生效，而不是只做一半移动。
- 两个接缝按**进程**安装一次，并挂在注册表实例上（用 `Symbol.for` 共享）：插件热重载不会叠加第二层包装，也不会用旧的归属表回答。代价是**禁用/卸载插件要重启 Host 才生效**——运行中移除它，已移动的会话仍留在目标工作区，重启后才回到「未分组」。
- 删除目标工作区会让其中被移动的会话回到「未分组」，重新归属表里的对应条目随之被清理。
- 会话的「当前工作目录」不会跟着改变：DSH 里 header 始终标识原始项目，只有会话内的工作目录可改。
- 归属表先于记录落盘：中途崩溃留下的「表里有、记录里没有」由下次启动的 `reconcile()` 补齐；反向的残留（同一条会话被两个工作区记账）会被清掉——那种状态会让注册表在启动校验时直接失败。修复补进去的会话和主动移动一样排在目标列表**头部**，整轮修复只落盘一次。
- 每次移动都在插件内串行执行（这条链挂在注册表实例上，插件热重载也不会出现第二条），并先确认目标记录真的收下了会话；失败时回滚归属表并把会话放回原工作区，不留下半移动。
- 接缝不可用时接口回 503，而不是拿一份没被尊重的归属表假装正常；`/state` 的投影与归属表在同一次串行快照里读取。
- 不支持把会话拖进「单列表」视图（那里没有分组），也不改变同一分组内的排序（仍由内置拖拽处理）。

## 界面与 DSH 视觉系统

插件不能引入 DSH 的 UI 组件包（primitives），所以界面按宿主自己的规则重建，并只使用主题 token：

| 位置 | 复用的宿主配方 |
| --- | --- |
| 会话行菜单项 | Menu item：13/20 字号行高、min-height 34、`6px 8px`、`--dsw-radius-md`、hover `--dsw-alias-interactive-bg-hover`、图标 14px `--dsw-alias-menu-icon` |
| 对话框卡片 | Modal：`--dsw-alias-bg-layer-2` 表面、`--dsw-radius-panel`、`--dsw-elevation-prominent`、遮罩 `--dsw-alias-bg-mask-1`（模糊用 `--dsw-mask-blur`，宿主默认是 `none`）、16/24 标题、14/22 说明段、`22px 14px 12px 24px` 头部、正文上距 20px、`0 24px` 页脚 |
| 工作区行 | 侧栏与目录选择框的两行行式：min-height 48、`--dsw-radius-lg`、13/20 500 标题、12/18 tertiary 路径、hover 与焦点环 token、当前项用 14px 勾选标记而非文字徽标、`--dsw-alias-border-l2` 分隔线 |
| 页脚按钮 | Button outline 变体：36px 高、`--dsw-radius-md`、`inset` 发丝描边 `--dsw-alias-border-l3` |
| 提示条 | Toast：`--dsw-alias-toast-bg` / `-label`、`--dsw-radius-lg`、`--dsw-shadow-lv3`、顶部居中、0.16s 上滑进场 + `--dsh-toast-hold`（默认 3s）后 1s 淡出，成功/失败各带状态图标 |
| 拖拽浮签 | Tooltip：`--dsw-alias-tooltip-bg` / `-label`、`--dsw-radius-sm`、`3px 7px`、13/20、无投影 |

样式以组件内 `<style>` 元素渲染，卸载即移除，不写宿主 DOM；hover 规则只在 `@media (hover:hover)` 下生效，`prefers-reduced-motion` 下关闭进场动画。对话框带 `aria-labelledby`、Escape 关闭、焦点进入卡片、Tab 循环与关闭后焦点归还。

## 兼容性

- 目标 DSH：`0.2.2-rc.3`（`engines.dsh` 声明为 `>=0.2.2-rc.3`）。依赖的是内部接缝，升级 DSH 后请先看 Host 日志：出现 `workspace-mover: … does not look like this DSH version` 即表示接缝变了，插件会退回原生校验。
- 无第三方依赖：Host 半侧只用 Node 内置模块，Client 半侧只从浏览器模块表取 `react`。
- 不做版本相关的数据迁移：`workspace-mover.json` 目前是 `{version: 1, moves}`；遇到更高 version 的表会拒读并在日志里说明。
