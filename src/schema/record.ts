import { z } from "zod";
import { BlobRefSchema } from "./blob";
import { UsageSchema } from "./usage";

/** Minimal content blocks for user/assistant messages. */
export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mediaType: z.string(),
    /** Base64-encoded image data. */
    data: z.string(),
  }),
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * Fields shared by every record. A session's history is a single-rooted tree
 * linked by parentId (single parent, multiple children allowed);
 * seq is the temporal ordering number.
 */
export const BaseRecordSchema = z.object({
  recordId: z.string(),
  parentId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  /** ISO 8601. */
  timestamp: z.iso.datetime(),
  /** Per-record model override, for mid-session model switches. */
  model: z.string().optional(),
  usage: UsageSchema.optional(),
});

export type BaseRecord = z.infer<typeof BaseRecordSchema>;

/** Minimal record set per the AHS draft: content records + state records. */
export const AhsRecordSchema = z.discriminatedUnion("type", [
  // Content records
  BaseRecordSchema.extend({
    type: z.literal("user_message"),
    content: z.array(ContentBlockSchema),
  }),
  BaseRecordSchema.extend({
    type: z.literal("assistant_message"),
    content: z.array(ContentBlockSchema),
  }),
  // Same content model as user_message; only the provenance differs —
  // harness-injected messages (re-prompts, cron reminders, background
  // notices, system reminders) get a first-class type, not a tag field.
  BaseRecordSchema.extend({
    type: z.literal("harness_message"),
    content: z.array(ContentBlockSchema),
  }),
  BaseRecordSchema.extend({
    type: z.literal("tool_call"),
    toolCallId: z.string(),
    /** Original tool name, preserved as-is. */
    name: z.string(),
    args: z.unknown(),
    /** Optional derived classification. */
    kind: z.string().optional(),
    /**
     * "interrupted" when the source session/turn ended without a paired
     * tool_result (no synthetic result is emitted); otherwise mirrors the
     * paired tool_result status. Exactly one of (paired result, interrupted).
     */
    status: z.enum(["completed", "failed", "interrupted"]).optional(),
  }),
  BaseRecordSchema.extend({
    type: z.literal("tool_result"),
    toolCallId: z.string(),
    content: z.union([z.string(), BlobRefSchema]),
    status: z.enum(["success", "error"]).optional(),
  }),
  // State records
  BaseRecordSchema.extend({
    type: z.literal("turn_boundary"),
    phase: z.enum(["start", "end"]),
    turnId: z.string().optional(),
  }),
  BaseRecordSchema.extend({
    type: z.literal("model_change"),
    model: z.string(),
    provider: z.string().optional(),
  }),
  BaseRecordSchema.extend({
    type: z.literal("compaction"),
    summary: z.string().optional(),
  }),
  /**
   * Structured record of harness goal verdicts (control-plane events only —
   * goal CREATION via ordinary tool calls stays a tool_call).
   */
  BaseRecordSchema.extend({
    type: z.literal("goal_update"),
    goalId: z.string().optional(),
    status: z.string(),
    reason: z.string().optional(),
  }),
]);

export type AhsRecord = z.infer<typeof AhsRecordSchema>;
export type AhsRecordType = AhsRecord["type"];
