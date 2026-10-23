/**
 * How to point a client at its proxy, as data. The terminal banner prints it
 * and Agent X-Ray shows it, so the two can never disagree.
 */
import type { Provider } from "./types.ts";

export interface ConnectStep {
  /** What this command is for, e.g. "one-off" or "every invocation". */
  title: string;
  command: string;
}

export interface ConnectInfo {
  id: string;
  label: string;
  /** The proxy's own `http://host:port`. */
  base: string;
  upstream: string;
  clientCommand: string;
  /** Something to do first, or the client will not reach the proxy. */
  setup?: string;
  steps: ConnectStep[];
  /** How to stop sending traffic through the proxy. */
  stop: string;
  credentials?: string;
}

/** Collapses the banner's hand-wrapped, indented continuation lines. */
function unwrap(text: string | undefined): string | undefined {
  return text?.replace(/\n\s*/g, " ");
}

export function connectInfo(provider: Provider, base: string, upstream: string): ConnectInfo {
  const notes = provider.banner ?? {};
  const env = provider.baseUrlEnvVar;
  const client = provider.clientCommand;
  const steps: ConnectStep[] = [];
  if (notes.invocation) {
    steps.push({ title: "every invocation, since there is no env var override", command: notes.invocation(base) });
  } else {
    steps.push({ title: "one-off, in another terminal", command: `${env}=${base} ${client}` });
    steps.push({ title: "for the whole shell session", command: `export ${env}=${base}\n${client}` });
  }
  if (notes.projectConfig) {
    steps.push({
      title: `persist for one project (${notes.projectConfig})`,
      command: `{ "env": { "${env}": "${base}" } }`,
    });
  }
  return {
    id: provider.id,
    label: provider.label,
    base,
    upstream,
    clientCommand: client,
    setup: unwrap(notes.setup),
    steps,
    stop: notes.invocation
      ? "Stop logging: stop passing the overrides above."
      : `Stop logging: unset ${env} (or drop the env block).`,
    credentials: unwrap(notes.credentials),
  };
}
