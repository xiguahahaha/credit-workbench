# 积分工作台 · Credit Workbench

一个纯本地的积分 / 额度到期管理看板。把各平台的积分批次和有效期集中记下来，自动算出「先用哪一笔」「哪天会过期」，避免临期积分白白作废。

界面是单个 HTML 文件，数据留在本机浏览器；可选的同步服务会从 TRAE / WorkBuddy / Qoder 拉取余额。

## 功能

| 模块 | 说明 |
| --- | --- |
| 总览 | 在用笔数、30 天内 / 7 天内到期数量、最近到期日 |
| 平台账户 | 按平台汇总余额，列出每个批次的数量、到期日、剩余天数 |
| 优先使用顺序 | 按到期日升序（FIFO）排出消耗顺序，并给出日均消耗建议 |
| 到期时间轴 | 对数压缩横轴展示剩余天数，紧急 / 临近 / 安全 / 已过期一眼可辨 |
| 主题 | 浅色（清晰）/ 深色（氛围）一键切换，选择记在浏览器本地 |
| 数据 | JSON 导入 / 导出，便于备份与迁移 |

状态判定：剩余 < 0 天为已过期，0–7 天紧急（红），8–30 天临近（黄），30 天以上或无到期日为安全（绿）。

## 快速开始

**环境**：Windows + Node.js 18 或更高版本。

双击项目根目录的 `启动积分工作台.cmd`，它会依次：

1. 检查 `node` 是否可用；
2. 若本机同步服务未运行，最小化启动 `sync/server.js`（监听 `127.0.0.1:8797`）；
3. 用默认浏览器打开 `credit-workbench.html`。

只想启动同步服务时，双击 `sync/start-sync.cmd`。

> 直接用浏览器打开 `credit-workbench.html` 也能手动记账，只是没有自动同步，页面顶部的同步条会提示服务未启动。

## 配置自动同步（可选）

同步服务读取 `sync/config.json`。仓库只提供空模板，请先复制：

```bat
copy sync\config.example.json sync\config.json
```

模板内容：

```json
{
  "qoderToken": "",
  "workbuddy": {
    "accessToken": "",
    "refreshToken": "",
    "expiresAt": 0,
    "connectedAt": 0
  }
}
```

各平台的取数方式：

- **TRAE** — 自动读取本机客户端登录态，无需配置。
- **Qoder** — 自动读取客户端登录态；也可在页面「同步设置」里填入访问令牌。
- **WorkBuddy** — 在「同步设置」里点「连接」，浏览器完成一次登录即可，凭证会写回本机 `sync/config.json`。

`sync/config.json` 已被 `.gitignore` 忽略，**切勿提交到仓库或分享出去**。文件缺失时服务会用空配置正常启动，只是同步不可用。

同步服务提供 `GET /api/health`、`GET /api/state`、`GET /api/sync`、`POST /api/config`，以及 WorkBuddy 登录用的 `/api/login/workbuddy/start` 与 `/api/login/workbuddy/poll`。

## 目录结构

```
credit-workbench.html          单文件前端：界面 + 全部交互逻辑
启动积分工作台.cmd             一键启动（检查 Node → 起服务 → 开页面）
README.md                     本说明
sync/
├─ server.js                  本地 HTTP 服务（仅监听 127.0.0.1）
├─ start-sync.cmd             只启动同步服务
├─ config.example.json        配置模板，不含凭证
├─ adapters/                  TRAE / WorkBuddy / Qoder 取数适配器
└─ lib/                       HTTP 工具、Qoder DPAPI 密钥读取
```

## 数据与隐私

- 手动录入的记录只存在浏览器 `localStorage`（键 `credit-ledger-v1`），不会上传到任何服务器。
- 同步服务只监听 `127.0.0.1`，不对外暴露；只请求各平台官方接口。
- 凭证只保存在本机 `sync/config.json`，不写入前端页面。
- 「导出」生成的 JSON 包含全部记录，请自行保管。

## 使用提示

- 首次打开会载入示例数据，点「清空示例，开始录入」即可开始记真实数据；页脚可随时恢复示例或清空全部。
- 点平台卡片里的批次行、时间轴上的行，或队列里的「处理」，可打开编辑弹窗修改或删除该笔记录。
- 焦点不在输入框时按 `n` 可快速记一笔。
- 两个 `.cmd` 必须保持 **GBK 编码 + CRLF 换行**（`.gitattributes` 已保护）。若被编辑器改存为 UTF-8 或 LF，CMD 会把中文提示当成命令执行并报错。

## 说明

各平台的接口与登录态可能随客户端版本变化，适配器届时可能需要更新。本项目为个人工具，未附带许可证文件，按需自用。
