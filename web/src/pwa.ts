import { registerSW as registerViteSW } from "virtual:pwa-register";

export function registerSW(): void {
  registerViteSW({
    immediate: true
  });
}
