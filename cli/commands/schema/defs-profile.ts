import { p, type SchemaDef } from "./types.js";

const s = { type: "string" };
const b = { type: "boolean" };

// profile 名は位置引数（`bitbank profile show main`）。`--name=` では受け取らない。
const name = p("string", "Profile name", { positional: true });

export const profileSchemas: Record<string, SchemaDef> = {
  add: {
    category: "profile",
    params: {
      name,
      description: p("string", "Free-form note stored alongside the profile"),
      default: p("boolean", "Also make this the default profile"),
    },
    // key/secret は flag 受け禁止（shell 履歴に残るため）。env か対話 hidden 入力のみ。
    output: { type: "object", properties: { added: s, default: b, description: s } },
  },
  list: {
    category: "profile",
    params: {},
    output: {
      type: "array",
      items: { type: "object", properties: { name: s, default: b, description: s } },
    },
  },
  show: {
    category: "profile",
    params: { name },
    output: {
      type: "object",
      properties: {
        name: s,
        default: b,
        keyMasked: s,
        secretMasked: s,
        description: s,
        createdAt: s,
      },
    },
  },
  remove: {
    category: "profile",
    params: {
      name,
      confirm: p(
        "boolean",
        "Required. Deletes the profile from profiles.json; the command refuses to run without it",
      ),
    },
    output: { type: "object", properties: { removed: s, defaultCleared: b } },
  },
  "set-default": {
    category: "profile",
    params: { name },
    output: { type: "object", properties: { default: s } },
  },
};
