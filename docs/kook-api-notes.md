# KOOK 接口与网关协议速查

本项目用到的 KOOK 官方 API（v3）。官方文档：<https://developer.kookapp.cn/doc>

## 基础

- 接口地址：`https://www.kookapp.cn/api/v3`
- 鉴权头：`Authorization: Bot <Token>`
- 返回格式：`{ "code": 0, "message": "...", "data": ... }`，`code ≠ 0` 即失败
- 列表分页：参数 `page`、`page_size`（本项目用 50）；返回 `data.items` + `data.meta.{page, page_total, page_size, total}`
- 限速：超速返回 HTTP 429，响应头 `X-Rate-Limit-Limit / Remaining / Reset / Bucket / Global`；反复超速会被警告直至禁用
- 机器人主动消息配额：同一开发者账号下所有机器人每天共 10,000 条（北京时间 12:00 重置）

## 用到的接口

✔ = 本项目实测可用　○ = 仅按文档核对

| 用途 | 方法 路径 | 关键参数 | 状态 |
|---|---|---|---|
| 机器人自身信息 | GET `/user/me` | — | ✔ |
| 所在服务器列表 | GET `/guild/list` | page | ✔ |
| 成员列表 | GET `/guild/user-list` | guild_id, role_id, filter_user_id, search | ✔ 返回含 user_count、online_count |
| 角色列表 | GET `/guild-role/list` | guild_id | ✔ |
| 创建角色 | POST `/guild-role/create` | guild_id, name | ✔ |
| 授予 / 撤销角色 | POST `/guild-role/grant`、`/guild-role/revoke` | guild_id, user_id, role_id | ✔ |
| 频道列表 | GET `/channel/list` | guild_id, type（1 文字 / 2 语音） | ✔ |
| 语音频道里有谁 | GET `/channel/user-list` | channel_id | ✔ 有几秒延迟 |
| 移动语音用户 | POST `/channel/move-user` | target_id（语音频道）, user_ids[] | ✔ 用户须已在另一语音频道 |
| 频道历史消息 | GET `/message/list` | target_id, page_size | ✔ |
| 频道发消息 | POST `/message/create` | type（9 KMarkdown / 10 卡片）, target_id, content, quote | ✔ |
| 私信 | POST `/direct-message/create` | type, target_id（用户ID）, content | ✔ |
| 创建邀请 | POST `/invite/create` | channel_id 或 guild_id, duration, setting_times | ✔ |
| 网关地址 | GET `/gateway/index` | compress=0 | ✔ |
| 机器人进语音频道 | POST `/voice/join`、`/voice/leave`、`/voice/keep-alive` | channel_id | ○ **只能推流播放，不能收音** |

## 角色权限位（`permissions & 值`）

| 值 | 权限 | 值 | 权限 |
|---|---|---|---|
| 1 | 管理员 | 1024 | 管理角色权限 |
| 2 | 管理服务器 | 2048 | 查看文字、语音频道 |
| 8 | 创建服务器邀请 | 4096 | 发布消息 |
| 32 | 频道管理 | 8192 | 管理消息 |
| 64 | 踢出用户 | 131072 | 提及@全体成员 |
| 128 | 封禁用户 | 67108864 | 修改他人昵称 |

机器人只能授予 / 撤销**排在自己角色下面**的角色，否则返回 `40300`。

## KMarkdown 与卡片

- KMarkdown **不会自动把网址变成链接**，要写成 `[文字](网址)`。
- 提及：`(met)用户ID(met)`；@全体 `(met)all(met)`；@角色 `(rol)角色ID(rol)`（本项目发言前会清除 @全体 / @在线 / @角色）。
- 卡片消息（type 10）的 `content` 是 JSON 字符串，常用模块：`header`、`section`、`divider`、`action-group`（按钮组，本项目每组不超过 4 个按钮）、`invite`（`{"type":"invite","code":"邀请链接或邀请码"}`，渲染成可一键加入的邀请卡）。
- 按钮 `click: "return-val"` 时，点击会产生 `message_btn_click` 系统事件，`extra.body` 含 `user_id`（点击者）、`value`（按钮值）、`msg_id`、`target_id`、`user_info`。

## 实时网关（WebSocket）

- 先 GET `/gateway/index?compress=0` 拿 `wss://` 地址再连接；6 秒内须收到 HELLO（`s=1`，`d.code=0` 成功；40101 / 40102 = Token 无效）
- 事件 `s=0` 带 `sn`：按 sn 顺序处理、去重，乱序先缓存
- 每 30±5 秒发 PING `{"s":2,"sn":最新sn}`，6 秒内没收到 PONG（`s=3`）视为断线
- `s=5` RECONNECT：清空 sn 和缓存，重新获取网关地址
- 文字消息事件：`d.channel_type` 为 `GROUP`（频道）或 `PERSON`（私信）；`d.type` 1 文本 / 9 KMarkdown / 255 系统事件；`d.target_id`、`d.author_id`、`d.content`、`d.msg_id`、`d.extra.{guild_id, channel_name, mention[], author}`
- 机器人能收到它**可见频道里的所有消息**，不需要被 @
- 本项目未实现 RESUME（断线续传）

## 踩过的坑

- 授予「管理员」报 `40300`：机器人角色排在管理员下面。
- 移动用户接口返回成功，但 `/channel/user-list` 结果有延迟。
- KOOK 的「在线」只表示开着客户端，判断活跃看 `active_time`。
- 机器人发的纯网址是白色纯文本：KMarkdown 需要 `[文字](网址)`，邀请最好用卡片的 `invite` 模块。
