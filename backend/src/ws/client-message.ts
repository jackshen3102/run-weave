import type { ClientInputMessage } from "@browser-viewer/shared";
import { z } from "zod";

const clientInputSchema = z.union([
  z.object({
    type: z.literal("mouse"),
    action: z.union([z.literal("click"), z.literal("move")]),
    x: z.number(),
    y: z.number(),
    button: z
      .union([z.literal("left"), z.literal("middle"), z.literal("right")])
      .optional(),
  }),
  z.object({
    type: z.literal("keyboard"),
    key: z.string().min(1),
    modifiers: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("clipboard"),
    action: z.literal("paste"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("scroll"),
    x: z.number().optional(),
    y: z.number().optional(),
    deltaX: z.number(),
    deltaY: z.number(),
  }),
  z.union([
    z.object({
      type: z.literal("tab"),
      action: z.literal("create"),
    }),
    z.object({
      type: z.literal("tab"),
      action: z.literal("switch"),
      tabId: z.string().min(1),
    }),
  ]),
  z
    .object({
      type: z.literal("navigation"),
      action: z.union([
        z.literal("goto"),
        z.literal("back"),
        z.literal("forward"),
        z.literal("reload"),
        z.literal("stop"),
      ]),
      tabId: z.string().min(1),
      url: z.string().min(1).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.action === "goto" && !value.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "url is required for goto action",
          path: ["url"],
        });
      }
    }),
  z.object({
    type: z.literal("devtools"),
    action: z.union([z.literal("open"), z.literal("close")]),
    tabId: z.string().min(1),
  }),
]);

export function parseClientMessage(raw: string): ClientInputMessage | null {
  try {
    const parsed = clientInputSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return null;
    }
    return parsed.data as ClientInputMessage;
  } catch {
    return null;
  }
}
