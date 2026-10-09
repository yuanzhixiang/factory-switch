import type { FactorySwitchApi } from "../shared/types";

declare global {
  interface Window {
    factorySwitch: FactorySwitchApi;
  }
}
