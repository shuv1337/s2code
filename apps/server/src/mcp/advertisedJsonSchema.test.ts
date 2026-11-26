import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { ThemeToolkit } from "./toolkits/theme/tools.ts";

it("drops JSON noise, merges tagged unions, and keeps null where it is required", () => {
  const Every = Schema.Struct({ ms: Schema.Int });
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      threadId: Schema.optional(Schema.NullOr(Schema.String)),
      beforeRunId: Schema.NullOr(Schema.String),
      limit: Schema.optional(Schema.Int),
      every: Schema.Union([Every, Schema.fromJsonString(Every)]),
      optionalJson: Schema.optional(Schema.NullOr(Schema.fromJsonString(Every))),
      target: Schema.optional(
        Schema.NullOr(
          Schema.Union([
            Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
          ]),
        ),
      ),
    }),
  });

  expect(advertisedJsonSchema(tool)).toEqual({
    type: "object",
    properties: {
      threadId: { type: "string" },
      beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
      limit: { type: "integer" },
      every: { type: "object", properties: { ms: { type: "integer" } }, required: ["ms"] },
      optionalJson: {},
      target: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["url", "number"] },
          url: { type: "string" },
          number: { type: "integer" },
        },
        required: ["kind"],
      },
    },
    required: ["beforeRunId", "every"],
  });
});

it("merges scalar types without narrowing their advertised values", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      choice: Schema.Union([Schema.Literals(["a", "b"]), Schema.Literals(["b", "c"])]),
      measurement: Schema.Union([
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
        Schema.Finite.check(Schema.isBetween({ minimum: -0.5, maximum: 2.5 })),
      ]),
      lowerBounded: Schema.Union([
        Schema.Finite.check(Schema.isBetween({ minimum: 10, maximum: 20 })),
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)),
      ]),
    }),
  });

  expect(advertisedJsonSchema(tool).properties).toEqual({
    choice: { type: "string", enum: ["a", "b", "c"] },
    measurement: { type: "number", minimum: -0.5, maximum: 10 },
    lowerBounded: { type: "number", minimum: 5 },
  });
});

it.each([
  {
    tool: AttachmentToolkit.tools.t3_attachment_prepare_upload,
    path: "upload.properties",
    minimum: 1,
  },
  {
    tool: AttachmentToolkit.tools.t3_thread_send_attachments,
    path: "attachments.items.properties",
    minimum: 0,
  },
])("advertises compact attachment fields for $tool.name", ({ tool, path, minimum }) => {
  const schema = advertisedJsonSchema(tool);
  expect(JSON.stringify(schema)).not.toContain('"anyOf":');
  expect(schema.properties).toHaveProperty(`${path}.mimeType`, { type: "string" });
  expect(schema.properties).toHaveProperty(`${path}.sizeBytes`, {
    type: "integer",
    minimum,
    maximum: 52_428_800,
  });
});

it("merges webhook filters with disjoint operators but keeps both value types", () => {
  expect(advertisedJsonSchema(OrchestratorToolkit.tools.schedule_task).properties).toHaveProperty(
    "schedule.properties.filters.items",
    expect.objectContaining({
      type: "object",
      properties: {
        op: { type: "string", enum: ["equals", "notEquals", "startsWith", "in", "exists"] },
        path: { type: "string" },
        value: {
          anyOf: [
            { type: "string" },
            expect.objectContaining({
              type: "array",
              items: expect.objectContaining({ type: "string" }),
              minItems: 1,
            }),
          ],
        },
      },
      required: ["op", "path"],
    }),
  );
});

it("does not mistake overlapping enums for a discriminator", () => {
  const tool = Tool.make("example", {
    parameters: Schema.Struct({
      value: Schema.Union([
        Schema.Struct({ kind: Schema.Literals(["a", "b"]), left: Schema.String }),
        Schema.Struct({ kind: Schema.Literals(["b", "c"]), right: Schema.Boolean }),
      ]),
    }),
  });
  expect(advertisedJsonSchema(tool).properties).toHaveProperty("value.anyOf", [
    expect.objectContaining({
      type: "object",
      properties: { kind: { type: "string", enum: ["a", "b"] }, left: { type: "string" } },
    }),
    expect.objectContaining({
      type: "object",
      properties: { kind: { type: "string", enum: ["b", "c"] }, right: { type: "boolean" } },
    }),
  ]);
});

it("advertises both delegated option shapes with their description", () => {
  expect(advertisedJsonSchema(OrchestratorToolkit.tools.delegate_task).properties).toHaveProperty(
    "target.properties.options",
    {
      anyOf: [
        expect.objectContaining({
          type: "array",
          items: expect.objectContaining({ type: "object", required: ["id", "value"] }),
        }),
        {
          type: "object",
          additionalProperties: { anyOf: [{ type: "string" }, { type: "boolean" }] },
        },
      ],
      description:
        "Ids vary by provider; see `orchestrator_capabilities`. Given values override inherited. [] or {} clears.",
    },
  );
});

it("advertises only string enum values, which Gemini requires", () => {
  const enumValues: Array<unknown> = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "enum" && Array.isArray(value)) enumValues.push(...value);
      else collect(value);
    }
  };
  collect(advertisedJsonSchema(ThemeToolkit.tools.t3_theme_set));

  expect(enumValues.filter((value) => typeof value !== "string")).toEqual([]);
});
