import * as Predicate from "effect/Predicate";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

// Gemini rejects function declarations whose enums hold anything but strings.
const isNonStringEnum = (key: string, value: Json) =>
  key === "enum" && Array.isArray(value) && value.some((item) => typeof item !== "string");

const stringEnum = (schema: Json) =>
  Predicate.isObject(schema) &&
  schema.type === "string" &&
  Array.isArray(schema.enum) &&
  schema.enum.length > 0 &&
  schema.enum.every(Predicate.isString)
    ? schema.enum
    : undefined;

const mergeScalars = (branches: ReadonlyArray<JsonObject>): JsonObject | undefined => {
  if (branches.every((branch) => branch.type === "string")) {
    const enums = branches.map(stringEnum);
    return enums.every((values) => values !== undefined)
      ? { type: "string", enum: [...new Set(enums.flat())] }
      : { type: "string" };
  }
  if (branches.every((branch) => branch.type === "boolean")) return { type: "boolean" };
  if (branches.every((branch) => branch.type === "integer" || branch.type === "number")) {
    const minimums = branches.map((branch) => branch.minimum);
    const maximums = branches.map((branch) => branch.maximum);
    return {
      type: branches.some((branch) => branch.type === "number") ? "number" : "integer",
      ...(minimums.every(Predicate.isNumber) ? { minimum: Math.min(...minimums) } : {}),
      ...(maximums.every(Predicate.isNumber) ? { maximum: Math.max(...maximums) } : {}),
    };
  }
  return undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<JsonObject>): JsonObject | undefined => {
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      branch.type === "object" && Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties)
    .map((key) => {
      const enums = objects.map((object) => stringEnum(object.properties[key]));
      if (enums.some((values) => values === undefined)) return undefined;
      const values = enums.flat();
      return new Set(values).size === values.length ? { key, values } : undefined;
    })
    .find((tag) => tag !== undefined);
  if (tag === undefined) return undefined;
  const properties: JsonObject = { [tag.key]: { type: "string", enum: tag.values } };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag.key) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag.key && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag.key, ...requiredByAll] };
};

const compact = (schema: Json, optional: boolean): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    if (isNonStringEnum(key, value)) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name)),
            ]),
          )
        : compact(value, false);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter((branch) => !(optional && isNullSchema(branch)) && !isJsonStringSchema(branch));
    const { anyOf: _anyOf, ...rest } = result;
    if (branches.length === 0) return rest;
    if (branches.length === 1 && Predicate.isObject(branches[0])) {
      return { ...branches[0], ...rest };
    }
    if (branches.length > 1 && branches.every(Predicate.isObject)) {
      const scalars = mergeScalars(branches);
      if (scalars !== undefined) return { ...scalars, ...rest };
      const tagged = mergeTaggedObjects(branches);
      if (tagged !== undefined) return compact({ ...tagged, ...rest }, optional);
    }
    return { ...rest, anyOf: branches };
  }
  return result;
};

/**
 * Drops redundant JSON keywords, JSON-string fallbacks, and optional null branches from what T3
 * advertises. Merges compatible scalar and disjoint tagged object unions but keeps heterogeneous
 * and required nullable unions. Decoding still uses the full schema.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(Tool.getJsonSchema(tool), false) as ReturnType<typeof Tool.getJsonSchema>;
