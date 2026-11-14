# 开票雷达 · GitHub 独立版

入口： https://z2vn7g8nhp-beep.github.io/polaris-isolated-lab-20261113/

网页由 GitHub Pages 提供，后台由 GitHub Actions 直接检查西安 MOMOPARK UME、荟聚寰映的猫眼排片。运行与日常使用均不请求 ChatGPT Sites，也不需要登录 ChatGPT。

## 使用

1. 打开上面的 Pages 地址，可以直接浏览片库。
2. 在「监测与推送」创建一次只限本仓库的 GitHub Fine-grained token：Repository access 选择本仓库，Contents 和 Actions 设为 Read and write。把它填进页面，连接一次。
3. 在片库点击 ☆ 星标电影。在「监测与推送」填 Bark 设备 Key，保存后发起测试通知。

配置和手动检查通过 Actions 执行，通常需要一两分钟。后台计划每 5 分钟触发，GitHub 高峰时可能延迟。关闭网页后仍继续检查。

## 数据与隐私

- `main`：网页、代码、公开的电影信息和 RSA 公钥。
- `preferences`：浏览器用 AES-GCM 加密的星标和 Bark 配置；AES 密钥再用 RSA-OAEP 封装给后台。
- `monitor-state`：加密的 SQLite 状态、加密的个人提醒记录，以及公开的片库快照。这个生成分支每轮覆盖，不累积完整数据库历史。
- GitHub token 只存在当前浏览器，不上传到仓库或后台；其派生密钥用于解密个人配置。因此跨设备使用同一个 token。更新或撤销 token 前，请保留旧 token，以便先解密迁移配置。
- Bark Key 在公开仓库中只以密文出现。监测到验证码、限流或访问限制会暂停，需本人在页面手动恢复。

后台沿用 Repository Secret `WATCH_SITE_TOKEN` 作为加密主密钥，仅为兼容已完成的配置；它不再用于访问旧站。不要修改这个 Secret，否则现有状态无法解密。`WATCH_SITE_URL` 已不使用。

## 验证与部署

```sh
node --test tests/*.test.mjs
```

`.github/workflows/scheduled-watch.yml` 负责检查、保存状态和发布 Pages。`.github/workflows/test.yml` 运行监测与加密回归测试。

初始片库来自原 Sites 项目的 185 部电影，旧项目源码和旧仓库未修改。旧项目的参考目录不会推送。

GitHub Pages 和 GitHub API 的实际访问情况取决于本地网络；改用 GitHub 不能保证任何网络下都可达。
