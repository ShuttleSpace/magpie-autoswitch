/**
 * Magpie host entry.
 *
 * Magpie resolves exports["./server"] before main, so this one function is
 * all it needs. The provider id is `free-switch`; the model agents pick is
 * `free-switch/auto`.
 */
import { createFreeSwitchPlugin } from "./src/plugin.mjs";

export async function FreeSwitchPlugin(input, options = {}) {
  return createFreeSwitchPlugin(input, options);
}
