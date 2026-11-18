/**
 * Wasm-only project activation.
 * `activateWasmProject` refuses JavaScript before a composition lease or a runtime.
 * General Node activation of JavaScript, Wasm, and mixed locks is `activateProject`.
 */
export {
  activateProject,
  activateWasmProject,
  type ProjectActivation as WasmProjectActivation,
  type ProjectActivationBackendOptions as WasmActivationBackendOptions,
  type ProjectActivationModuleIdentity as WasmActivationModuleIdentity,
  type ProjectActivationOptions as WasmProjectActivationOptions,
} from "./project-activation.ts";
