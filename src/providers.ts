/**
 * The provider registry. One entry per AI client/API the proxy can structure
 * logs for; unknown traffic still gets proxied and captured, just unstructured.
 */
import type { Provider } from "./core/types.ts";
import { claude } from "./claude/index.ts";

export const providers: Provider[] = [claude];

export const defaultProvider = claude;

export function getProvider(id: string | undefined): Provider {
  if (!id) return defaultProvider;
  const hit = providers.find((p) => p.id === id.toLowerCase());
  if (!hit) {
    throw new Error(
      `Unknown provider "${id}". Available: ${providers.map((p) => p.id).join(", ")}`,
    );
  }
  return hit;
}
