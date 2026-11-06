# 更新日志

## 未发布

### 修复

- 首条消息页的模型选择弹窗/触发条中模型名显示为空（只剩分组名）。原因：插件内置的 stock 控件
  渲染器没有按 DSH 运行时契约转发 `renderSlot` 的第三个 `opts` 参数，导致 stock 组件为
  `conversation.input.model.label` 槽传入的 `fallback`（即模型名）在无扩展注册该槽时丢失。
  现已镜像运行时契约（single/keyed/list + `opts.fallback` 回退、keyed 按 `opts.entryKey`
  查找）、异常路径回退 fallback，并补上 stock 控件槽挂载点的 anchor 标记。

### 新增

- 工作区外会话的首条消息支持选择、拖入文件，以及粘贴图片；可移除已添加的附件。
- 图片随消息发送，其他文件通过 DSH 的文件上传服务发送；发送失败时保留输入内容和附件。

### 已知限制

- 首条消息暂不支持 slash 指令和 `@` 引用补全；发送后可使用 DSH 标准输入框。
- 附件受 DSH 宿主的格式及大小限制。
