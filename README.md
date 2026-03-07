# opencode-plugin-manager

`opencode-plugin-manager` is an opencode meta-plugin that manages plugin sources from npm, git repositories, and local paths.

It does not auto-download on startup. You explicitly run `opm.sync` to install/update plugins, and startup loads from locked plugin paths.

## Install

Add the plugin manager to your opencode config:

```jsonc
{
  "plugin": ["opencode-plugin-manager"]
}
```

## Configure plugins

Create `plugins.json` (or `plugins.jsonc`) in your global opencode config directory (`~/.config/opencode`):

```jsonc
{
  "$schema": "./plugins.schema.json",
  "cacheDir": "~/.cache/opencode/plugins",
  "plugins": [
    "example-plugin@1.2.3",
    "./plugins/my-local-plugin",
    {
      "source": "git",
      "repo": "https://github.com/acme/opencode-git-plugin.git",
      "ref": "v1.0.0",
      "entry": "./dist/index.js"
    },
    {
      "source": "local",
      "path": "../my-local-plugin",
      "entry": "./dist/index.js",
      "build": {
        "command": "npm run build"
      }
    }
  ]
}
```

## Install and update flow

Run tools from opencode:

- `opm.install` installs plugins from `plugins.json` and reuses compatible locked versions.
- `opm.update` refreshes plugins to the newest versions matching configured constraints.
- `opm.clean` removes cached plugin directories and lock entries that are no longer referenced.
- `opm.sync` runs install and then clean.
- `opm.self-update` checks npm for a newer `opencode-plugin-manager` release and tells you what to pin in `opencode.json`.

Install/update writes `plugins.lock.json` in the configured cache directory.
Install/update output also includes per-plugin state transitions (`before -> after`) with resolved versions/commits.

## Slash command templates

opencode slash commands are prompt templates, so add command entries that call these tools:

```jsonc
{
  "command": {
    "opm-install": {
      "description": "Install managed plugins",
      "template": "Run the opm.install tool to install managed plugins from plugins.json."
    },
    "opm-update": {
      "description": "Update managed plugins",
      "template": "Run the opm.update tool to update managed plugins to the highest versions that match constraints."
    },
    "opm-clean": {
      "description": "Clean stale managed plugin cache",
      "template": "Run the opm.clean tool to remove stale managed plugin cache entries and prune lock entries."
    },
    "opm-sync": {
      "description": "Install then clean managed plugins",
      "template": "Run the opm.sync tool to install managed plugins and then clean stale cache entries."
    },
    "opm-self-update": {
      "description": "Check plugin-manager updates",
      "template": "Run the opm.self-update tool and report whether an update is available."
    }
  }
}
```

Then use `/opm-install`, `/opm-update`, `/opm-clean`, `/opm-sync`, and `/opm-self-update`.

This repo also includes starter templates in `commands/` that you can copy into `.opencode/commands/`.

## Behavior

- Startup loads plugins from locked paths (cached installs and local paths).
- Only global config is loaded from `~/.config/opencode/plugins.json` or `~/.config/opencode/plugins.jsonc`.
- Failed plugin sync/load logs a warning and continues.
- Build commands are never auto-run; they only run when explicitly set with `build.command`.
- If `entry` is configured, it takes precedence. Otherwise, `opencode.plugin.ts` is used automatically when present.
- Tool/auth collisions are last-write-wins with warnings.
