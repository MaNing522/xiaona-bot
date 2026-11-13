Stapxs QQ Lite 2.0（网页版 QQ 客户端）静态资源
================================================

来源：https://stapxs.github.io/Stapxs-QQ-Lite-2.0/ （原样镜像，未改动编译产物）
项目：https://github.com/Stapxs/Stapxs-QQ-Lite-2.0
许可：见 Stapxs-QQ-Lite-2.0 仓库（GNU General Public License v3.0）

本项目只做三件事：
1. 用登录后的面板身份托管这些静态文件（/ssqq 与 /Stapxs-QQ-Lite-2.0/*）；
2. 提供同源 WebSocket 反向代理 /ssqq/ws → 本机 OneBot（127.0.0.1:3001，服务端补 token）；
3. 首页「网页 QQ」指向 /ssqq。

首次打开 /ssqq 时，在它的连接页填：
    地址：ws://<当前面板地址>/ssqq/ws
    令牌：（留空）
之后浏览器会记住这份配置。

重新镜像/升级：
    python 脚本抓 https://stapxs.github.io/Stapxs-QQ-Lite-2.0/ 整站到本目录即可（保留目录结构）。
