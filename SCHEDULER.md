# 更稳定的定时触发

GitHub Actions 的 cron 只是触发计划，不保证准点。此项目已实际观察到约 52～72 分钟才触发一次，不能把 `*/5` 当作稳定的五分钟监测。抓取周期配置只在任务启动后生效。

网页会展示真实的成功检查时间；6 分钟未成功检查会提示延迟，失败或暂停会显示对应状态。配置保存或任务启动不会冒充成功抓取。

## 增加外部两分钟触发

可以使用自己信任的定时 HTTP 服务，例如 cron-job.org。网页、数据和后台继续保留在本 GitHub 仓库。此文档本身不会创建外部任务，也不会传送凭据。

为定时服务单独创建一个 GitHub Fine-grained token：只允许本仓库，Repository permissions 中仅授予 Actions 的 Read and write（Metadata 自动只读）。不要复用网页同步使用的 Contents 写入 token。

定时服务配置：

- 周期：每 2 分钟，启用任务。
- 方法：POST。
- URL：`https://api.github.com/repos/z2vn7g8nhp-beep/polaris-isolated-lab-20261113/actions/workflows/scheduled-watch.yml/dispatches`
- 请求头：`Authorization: Bearer <专用 token>`、`Accept: application/vnd.github+json`、`Content-Type: application/json`。
- JSON 请求体：`{"ref":"main","inputs":{"mode":"check"}}`。
- 时区：Asia/Shanghai；超时：30 秒。

只把专用 token 保存在该服务受保护的请求头配置中，不写入本仓库或聊天。外部服务会持有这份有限权限的凭据，请自行选择信任的服务。

保存后执行 Test run。HTTP 204 表示任务已提交，还需要核对 Actions 执行完成以及网页成功检查时间变新。GitHub 自带的每 5 分钟 cron 保留兜底；两种触发共用 110 秒冷却，避免重复访问。失败退避和风控暂停仍然生效；开票维持两分钟目标，猫眼待映、热映名单和电影资料按五分钟时钟整轮更新；两分钟触发取整后，正常整轮间隔可能约 4～6 分钟。
