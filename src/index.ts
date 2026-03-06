import type { Plugin } from "@opencode-ai/plugin"
import { loadMergedConfig } from "./config"

export const PluginManager: Plugin = async (input) => {
  const config = await loadMergedConfig(input)

  return {
    async config() {
      if (!config.plugins.length) {
        console.info("[plugin-manager] No managed plugins configured")
      }
    },
  }
}

export default PluginManager
