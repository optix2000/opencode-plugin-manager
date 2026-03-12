# opencode-plugin-manager

A plugin manager for [opencode](https://opencode.ai). Manages plugins from npm, git repos, and local paths.

By default, plugins are only installed/updated when you explicitly run a tool — nothing downloads on startup. Enable `autoinstall` and/or `autoprune` to change this.

## Features

- npm, git, and local plugin sources
- Version pinning and lock file
- Automatic bundling and install scripts when configured
- Hot reload on tool-triggered refreshes (with [limitations](#limitations))

## Install

Add the plugin manager to your opencode config:

```jsonc
{
  "plugin": ["opencode-plugin-manager"]
}
```

For local development:

```sh
bun run bundle
cp dist/plugin-manager.js ~/.config/opencode/plugins/plugin-manager.js
```

OpenCode autoloads `.js` files from `~/.config/opencode/plugins/`.

## Configuration

Create `plugins.json` (or `plugins.jsonc`) in `~/.config/opencode/`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/optix2000/opencode-plugin-manager/main/plugins.schema.json",
  "cacheDir": "~/.cache/opencode/opm",
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

### Plugin entries

Plugins can be a shorthand string or an object with more options.

**String shorthands:**

- `"my-plugin@1.2.3"` — npm package with optional version constraint
- `"./path/to/plugin"` — local path (relative to the config file's directory, absolute, or `~/`)

**Object keys:**

| Key | Sources | Required | Description |
|-----|---------|----------|-------------|
| `source` | all | yes | `"npm"`, `"git"`, or `"local"` |
| `name` | npm | yes | npm package name |
| `version` | npm | no | semver range (default: `"latest"`) |
| `repo` | git | yes | git clone URL |
| `ref` | git | no | branch, tag, or commit to checkout |
| `path` | local | yes | path to plugin directory or file (relative paths resolve against the config file's directory) |
| `entry` | all | no | entry file override, or an array of entrypoints to load multiple plugins from the same source (default: auto-detected `opencode.plugin.ts`) |
| `build.command` | git, local | no | shell command to run after clone/checkout |
| `build.timeout` | git, local | no | build timeout in ms (max 300000) |

#### Multiple entrypoints

If a single repository or package contains multiple plugins, use an array for `entry`:

```jsonc
{
  "source": "local",
  "path": "./my-monorepo",
  "entry": ["./packages/plugin-a/dist/index.js", "./packages/plugin-b/dist/index.js"],
  "build": { "command": "npm run build" }
}
```

Each entrypoint is treated as a separate plugin with its own ID, lock entry, and lifecycle. The build command (if any) runs once per entrypoint.

### Top-level keys

| Key | Required | Description |
|-----|----------|-------------|
| `cacheDir` | no | Where to store cached plugins (default: `~/.cache/opencode/opm`) |
| `autoinstall` | no | Automatically install plugins on startup (default: `false`) |
| `autoprune` | no | Automatically prune stale cache on startup (default: `false`) |
| `plugins` | yes | Array of plugin entries |

## Tools

Run these from within opencode:

| Tool | Description |
|------|-------------|
| `opm_install` | Install plugins from `plugins.json`, reusing locked versions |
| `opm_update` | Update plugins to newest versions matching constraints |
| `opm_prune` | Remove cached versions not referenced by current config |
| `opm_sync` | Install + prune in one step |
| `opm_self_update` | Check for a newer release of the plugin manager itself |

Install/update writes `plugins.lock.json` in the cache directory and shows per-plugin state transitions.

## Limitations

- Only reads global config (`~/.config/opencode/plugins.json`) — no per-project plugin configs.
- If multiple plugins register the same tool or auth provider, last-write-wins.
- Hook code reloads on tool-triggered refreshes, but opencode caches some state per instance.
- Changes to tool registration or auth-provider behavior may require restarting opencode.
- OpenCode doesn't support slash commands from plugins, so you need to register them yourself. Starter templates are included in `commands/` — copy them into `.opencode/commands/` to get `/opm-install`, `/opm-update`, etc.
