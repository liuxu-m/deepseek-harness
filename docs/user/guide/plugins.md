# Reuse the installed Web plugins

English | [中文](plugins.zh.md)

This page records the community plugins installed in the current `web` profile. Run the commands from a machine with DeepSeek Harness available on `PATH`.

## Install the same plugins

Install the historical token usage page, the workspace Explorer and Preview panels, and the skin center:

```sh
dsh plugin --profile web add github:LaoYueHanNi/dsh-token-usage
dsh plugin --profile web add @linxin666/dsh-client-ui-aionui-panel
dsh plugin --profile web add @linxin666/dsh-skins
```

The installed versions in the current profile are `dsh-token-usage` `0.2.2`, `@linxin666/dsh-client-ui-aionui-panel` `0.1.20`, and `@linxin666/dsh-skins` `0.1.20`. Package resolution may select newer versions when the profile lockfile is not copied.

## What they provide

- `dsh-token-usage` records model requests, backfills existing session logs, and provides date-filtered daily totals, per-model usage, and cost estimates under **Settings → Token Usage**.
- `@linxin666/dsh-client-ui-aionui-panel` adds the right-side Explorer and Preview panels. Explorer shows the current workspace tree and Git changes; Preview supports source viewing, split editing, and saving files.
- `@linxin666/dsh-skins` adds the skin center and community themes.

## Activate and verify

Restart the running `dsh web` process after installation, then refresh the Web UI. Open a project session with a workspace to use the Explorer and Preview panels.

Verify the profile entries with:

```sh
dsh plugin --profile web why dsh-token-usage
dsh plugin --profile web why @linxin666/dsh-client-ui-aionui-panel
dsh plugin --profile web why @linxin666/dsh-skins
dsh --profile web --dump-config
```

The token usage plugin stores its local statistics under `$DSH_HOME/token-usage/`. Credentials and provider settings remain machine-local; do not commit them to this repository.

## Security note

These are community plugins. Installing one runs third-party code with the permissions of the DSH process, so review each source and test unfamiliar plugins in a separate profile before using credentials or important workspaces.
