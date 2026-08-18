# 复用已安装的 Web 插件

[English](plugins.md) | 中文

本页记录当前 `web` profile 中安装的社区插件。请在已将 DeepSeek Harness 加入 `PATH` 的机器上执行这些命令。

## 安装同样的插件

安装历史 Token 用量页面，以及工作区 Explorer 与 Preview 面板：

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
dsh plugin --profile web add @linxin666/dsh-client-ui-aionui-panel
```

当前 profile 中已验证的版本为 `dsh-token-usage` `0.2.2` 和 `@linxin666/dsh-client-ui-aionui-panel` `0.1.20`。不复制 profile lockfile 时，包管理器可能解析到更新版本。

## 提供的功能

- `dsh-token-usage` 记录模型请求、回填已有会话日志，并在**设置 → Token Usage**中提供按日期筛选的每日总量、按模型用量和费用估算。
- `@linxin666/dsh-client-ui-aionui-panel` 添加右侧 Explorer 与 Preview 面板。Explorer 显示当前工作区目录树和 Git 变更；Preview 支持查看源码、分屏编辑和保存文件。

## 生效与验证

安装后重启正在运行的 `dsh web` 进程，再刷新 Web UI。打开一个带工作区的项目会话即可使用 Explorer 和 Preview 面板。

使用以下命令验证 profile 配置：

```sh
dsh plugin --profile web why dsh-token-usage
dsh plugin --profile web why @linxin666/dsh-client-ui-aionui-panel
dsh --profile web --dump-config
```

Token 用量插件将本地统计写入 `$DSH_HOME/token-usage/`。凭据和模型提供方配置仍属于机器本地数据；不要将它们提交到本仓库。

## 安全提示

这些是社区插件。安装插件会以 DSH 进程权限运行第三方代码，因此请先检查源码；使用凭据或重要工作区前，应在独立 profile 中测试不熟悉的插件。
