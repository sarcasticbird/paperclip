import type { AdapterSessionCodec } from "./types.js";

/** Execution-target identity belongs to the shared runtime, not a provider's
 * session codec. Preserve only its closed, credential-free identity fields. */
function retainIdentity(input: unknown, decoded: Record<string, unknown> | null) {
  if (!decoded || !input || typeof input !== "object" || !Object.hasOwn(input, "remoteExecution")) return decoded;
  const raw = (input as Record<string, unknown>).remoteExecution;
  const identity = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const keys = identity.transport === "sandbox"
    ? ["transport", "providerKey", "environmentId", "leaseId", "remoteCwd"]
    : identity.transport === "ssh" ? ["transport", "host", "port", "username", "remoteCwd"] : [];
  // Invalid remote state must not become an empty identity that matches local.
  const remoteExecution = keys.length ? Object.fromEntries(keys.flatMap(key => {
    const value = identity[key];
    return value === null || typeof value === "string" || (key === "port" && typeof value === "number" && Number.isFinite(value))
      ? [[key, value]] : [];
  })) : { transport: "invalid" };
  return { ...decoded, remoteExecution };
}

export function withExecutionTargetSessionIdentity(codec: AdapterSessionCodec): AdapterSessionCodec {
  return {
    deserialize: raw => retainIdentity(raw, codec.deserialize(raw)),
    serialize: params => retainIdentity(params, codec.serialize(params)),
    ...(codec.getDisplayId ? { getDisplayId: (params: Record<string, unknown> | null) => codec.getDisplayId!(params) } : {}),
  };
}
