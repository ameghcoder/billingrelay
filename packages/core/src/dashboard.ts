// Shapes for the dashboard's admin GET routes, parsed on the way out so nothing else can slip into a response.
// One place for the routes, and later the AI tools and MCP that read the same data.
import { z } from "zod";
import { FULFILLMENT_STATUSES, MONEY_REASONS, MONEY_STATUSES } from "./checkouts";
import { CHECKOUT_SYNC_STATUSES, DESTINATION_STATES, OUTBOX_STATUSES, SYNC_ENTITY_TYPES, SYNC_OUTCOMES } from "./sync";

export const PAYPAL_EVENT_STATUSES = ["pending", "processed", "ignored", "failed"] as const;
export const OUTBOX_ENTITY_TYPES = SYNC_ENTITY_TYPES;
export const DASHBOARD_MONEY = [...MONEY_STATUSES, "expired"] as const;
// `not_delivered`: every sync state but `delivered`.
export const DASHBOARD_SYNC_FILTERS = [...CHECKOUT_SYNC_STATUSES, "not_delivered"] as const;

const pageSchema = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};

export const checkoutQuerySchema = z.strictObject({
  money: z.enum(DASHBOARD_MONEY).optional(),
  fulfillment: z.enum(FULFILLMENT_STATUSES).optional(),
  sync: z.enum(DASHBOARD_SYNC_FILTERS).optional(),
  ...pageSchema,
});
export type CheckoutQuery = z.input<typeof checkoutQuerySchema>;

export const eventQuerySchema = z.strictObject({
  status: z.enum(PAYPAL_EVENT_STATUSES).optional(),
  eventType: z.string().min(1).max(100).optional(),
  ...pageSchema,
});
export type EventQuery = z.input<typeof eventQuerySchema>;

export const deliveryQuerySchema = z.strictObject({
  status: z.enum(OUTBOX_STATUSES).optional(),
  entityType: z.enum(OUTBOX_ENTITY_TYPES).optional(),
  ...pageSchema,
});
export type DeliveryQuery = z.input<typeof deliveryQuerySchema>;

const checkoutRowSchema = z.strictObject({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  externalCustomerId: z.string(),
  productRef: z.string(),
  amount: z.number(),
  currency: z.string(),
  money: z.enum(DASHBOARD_MONEY),
  moneyReason: z.enum(MONEY_REASONS).nullable(),
  fulfillment: z.enum(FULFILLMENT_STATUSES),
  sync: z.enum(CHECKOUT_SYNC_STATUSES),
  paypalOrderId: z.string().nullable(),
  paypalCaptureId: z.string().nullable(),
});
export type DashboardCheckoutRow = z.infer<typeof checkoutRowSchema>;

export const checkoutListSchema = z.strictObject({
  rows: z.array(checkoutRowSchema),
  total: z.number(),
  // One entry per currency. Amounts in different currencies are never added together.
  totals: z.array(z.strictObject({ currency: z.string(), count: z.number(), amount: z.number() })),
});
export type CheckoutList = z.infer<typeof checkoutListSchema>;

const eventRowSchema = z.strictObject({
  id: z.string(),
  paypalEventId: z.string(),
  eventType: z.string(),
  status: z.enum(PAYPAL_EVENT_STATUSES),
  attempts: z.number(),
  failureCode: z.string().nullable(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
  checkoutId: z.string().nullable(),
  externalCustomerId: z.string().nullable(),
});
export type DashboardEventRow = z.infer<typeof eventRowSchema>;

export const eventListSchema = z.strictObject({ rows: z.array(eventRowSchema), total: z.number(), eventTypes: z.array(z.string()) });
export type EventList = z.infer<typeof eventListSchema>;

const attemptOutcome = z.enum(SYNC_OUTCOMES);

const deliveryRowSchema = z.strictObject({
  id: z.string(),
  entityType: z.enum(OUTBOX_ENTITY_TYPES),
  entityId: z.string(),
  checkoutId: z.string().nullable(),
  externalCustomerId: z.string().nullable(),
  sourceVersion: z.number(),
  status: z.enum(OUTBOX_STATUSES),
  attempts: z.number(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  lagSeconds: z.number(),
  lastAttempt: z
    .strictObject({ at: z.string(), outcome: attemptOutcome, code: z.string().nullable(), durationMs: z.number().nullable() })
    .nullable(),
});
export type DashboardDeliveryRow = z.infer<typeof deliveryRowSchema>;

export const deliveryListSchema = z.strictObject({ rows: z.array(deliveryRowSchema), total: z.number() });
export type DeliveryList = z.infer<typeof deliveryListSchema>;

export const attentionSchema = z.strictObject({
  failedEvents: z.number(),
  unclearCheckouts: z.number(),
  failedDeliveries: z.number(),
  destination: z.strictObject({ state: z.enum(DESTINATION_STATES), code: z.string().nullable(), downSince: z.string().nullable() }),
  webhook: z.strictObject({ status: z.enum(["registered", "not_registered"]), code: z.string().nullable() }).nullable(),
});
export type AttentionResponse = z.infer<typeof attentionSchema>;

const traceStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("checkout_created"), at: z.string() }),
  z.strictObject({ kind: z.literal("capture_requested"), at: z.string() }),
  z.strictObject({
    kind: z.literal("event"),
    at: z.string(),
    eventType: z.string(),
    status: z.enum(PAYPAL_EVENT_STATUSES),
    attempts: z.number(),
    failureCode: z.string().nullable(),
  }),
  z.strictObject({ kind: z.literal("effect"), at: z.string(), effect: z.string(), paypalPaymentId: z.string() }),
  z.strictObject({ kind: z.literal("grant"), at: z.string(), grantId: z.string(), accessKey: z.string(), status: z.enum(["active", "restricted"]) }),
  z.strictObject({
    kind: z.literal("outbox"),
    at: z.string(),
    outboxId: z.string(),
    entityType: z.enum(OUTBOX_ENTITY_TYPES),
    sourceVersion: z.number(),
    status: z.enum(OUTBOX_STATUSES),
    attempts: z.number(),
    failureCode: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("sync_attempt"),
    at: z.string(),
    outboxId: z.string(),
    entityType: z.enum(OUTBOX_ENTITY_TYPES),
    sourceVersion: z.number(),
    outcome: attemptOutcome,
    code: z.string().nullable(),
    durationMs: z.number().nullable(),
  }),
]);
export type TraceStepView = z.infer<typeof traceStepSchema>;

export const customerTraceSchema = z.strictObject({
  externalCustomerId: z.string(),
  checkouts: z.array(checkoutRowSchema.extend({ steps: z.array(traceStepSchema) })),
});
export type CustomerTraceView = z.infer<typeof customerTraceSchema>;

/** Query string to a plain object, so the strict schemas can name a parameter that isn't supported. */
export const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);
