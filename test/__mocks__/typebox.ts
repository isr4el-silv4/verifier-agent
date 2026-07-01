// Mock for typebox — only Type.Object/String/Optional/Union/Literal are used
// by verifier.ts (verifier_prompt tool parameters).
export const Type = {
  Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
  String: (opts?: Record<string, unknown>) => ({ type: "string", ...(opts || {}) }),
  Optional: (schema: unknown) => ({ ...(schema as object), optional: true }),
  Union: (schemas: unknown[]) => ({ anyOf: schemas }),
  Literal: (val: unknown) => ({ const: val }),
};
