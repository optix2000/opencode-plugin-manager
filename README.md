# opencode-plugin-manager

`opencode-plugin-manager` is an opencode meta-plugin that manages plugin sources from npm, git repositories, and GitHub releases.

It does not auto-download on startup. You explicitly run `plugin-manager.sync` to install/update plugins, and startup loads only cached plugins.

## Install

Add the plugin manager to your opencode config:

```jsonc
{
  "plugin": ["opencode-plugin-manager"]
}
```

## Configure plugins

Create `plugins.json` (or `plugins.jsonc`) in `.opencode/` or your global opencode config directory:

```jsonc
{
  "$schema": "./plugins.schema.json",
  "cacheDir": "~/.cache/opencode/plugins",
  "plugins": [
    "example-plugin@1.2.3",
    {
      "source": "git",
      "repo": "https://github.com/acme/opencode-git-plugin.git",
      "ref": "v1.0.0",
      "entry": "./dist/index.js"
    },
    {
      "source": "github-release",
      "repo": "acme/opencode-release-plugin",
      "tag": "v0.4.0",
      "asset": "plugin.js",
      "assetDigest": "sha256:optionaldigest"
    }
  ]
}
```

`assetDigest` is optional. Provide it when you want strict digest verification for GitHub release assets.

## Sync flow

Run the tool from opencode:

- `plugin-manager.sync`
- `plugin-manager.sync {"force":true}`

The sync process updates `plugins.lock.json` in the configured cache directory.

## Behavior

- Startup loads cached plugins only.
- Failed plugin sync/load logs a warning and continues.
- Build commands are never auto-run; they only run when explicitly set with `build.command`.
- Tool/auth collisions are last-write-wins with warnings.
