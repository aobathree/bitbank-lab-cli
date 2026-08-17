import { EXIT } from "../../exit-codes.js";
import { output } from "../../output.js";
import type { CommandHandler } from "../handler-types.js";
import { ALL_SCHEMAS } from "./registry.js";
import { type SchemaDef, SUBCOMMAND_GROUPS } from "./types.js";

function toParamsJsonSchema(params: SchemaDef["params"]): object {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [name, def] of Object.entries(params)) {
    const prop: Record<string, unknown> = { type: def.type, description: def.description };
    if (def.enum) prop.enum = def.enum;
    if (def.default !== undefined) prop.default = def.default;
    if (def.positional) prop.positional = true;
    properties[name] = prop;
  }
  return { type: "object", properties, required };
}

function listAll(descriptions: Record<string, string>, group?: string) {
  return Object.entries(ALL_SCHEMAS)
    .filter(([, schema]) => group === undefined || schema.category === group)
    .map(([command, schema]) => ({
      command,
      category: schema.category,
      description: descriptions[command] ?? "",
      params: Object.keys(schema.params),
    }));
}

/** 引数をカタログのキー（= 呼び出しパス）へ解決する。素のサブコマンド名も引けるが、
 *  複数グループに同名がある場合（trade / paper の create-order 等）は候補を挙げて
 *  エラーにする。黙って片方を返すと、存在しない呼び出し方を案内する原因になる。 */
function resolveKey(args: string[]): { key: string } | { error: string } {
  const [head, second] = args;
  if (SUBCOMMAND_GROUPS.has(head) && second) {
    const key = `${head} ${second}`;
    return key in ALL_SCHEMAS ? { key } : { error: `Unknown command: "${key}"` };
  }
  if (head in ALL_SCHEMAS) return { key: head };
  const matches = Object.keys(ALL_SCHEMAS).filter((k) => k.endsWith(` ${head}`));
  if (matches.length === 1) return { key: matches[0] };
  if (matches.length > 1) {
    return { error: `Ambiguous command: "${head}". Use one of: ${matches.join(", ")}` };
  }
  return { error: `Unknown command: "${head}"` };
}

function detail(key: string, descriptions: Record<string, string>) {
  const schema = ALL_SCHEMAS[key];
  return {
    command: key,
    category: schema.category,
    description: descriptions[key] ?? "",
    params: toParamsJsonSchema(schema.params),
    output: schema.output,
  };
}

/** Per-command catalog accessor: the same payload `schema <cmd>` emits, unwrapped (data only).
 *  scripts/gen-agents-catalog.ts builds agents/tool-catalog.json through this so the catalog
 *  can't drift from the live schema command. Takes an ALL_SCHEMAS key (the invocation path,
 *  e.g. "paper assets"); returns null for unknown commands. */
export function commandDetail(name: string, descriptions: Record<string, string>) {
  return name in ALL_SCHEMAS ? detail(name, descriptions) : null;
}

export function buildSchemaHandler(descriptions: Record<string, string>): CommandHandler {
  return async (args, _values, fmt) => {
    if (args.length === 0) {
      output({ success: true, data: listAll(descriptions) }, fmt);
      return;
    }
    // `schema paper` のようにグループ名だけ渡されたらグループ内の一覧を返す
    // （エージェントが最初に試す形。Unknown で突き放さない）。
    if (args.length === 1 && SUBCOMMAND_GROUPS.has(args[0])) {
      output({ success: true, data: listAll(descriptions, args[0]) }, fmt);
      return;
    }
    const r = resolveKey(args);
    output(
      // 未知・曖昧はどちらも入力エラー。exitCode を省くと output.ts の
      // `?? 1` で GENERAL に落ち、bot が内部エラーと誤認する（chaos x16 の趣旨）。
      "error" in r
        ? { success: false, error: r.error, exitCode: EXIT.PARAM }
        : { success: true, data: detail(r.key, descriptions) },
      fmt,
    );
  };
}
