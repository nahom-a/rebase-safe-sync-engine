// Schema v3 = v2 + one new node type ("link") + two optional fields
// + widens item.priority with a new enum member ("urgent").
import { schema as v2 } from "./schema.v2.js";

export const schema = {
  version: 3,
  nodeTypes: {
    ...v2.nodeTypes,
    section: {
      fields: {
        ...v2.nodeTypes.section.fields,
        color: { type: "string", optional: true },
      },
    },
    item: {
      fields: {
        ...v2.nodeTypes.item.fields,
        estimate: { type: "number", optional: true },
        priority: { type: "enum", values: ["low", "med", "high", "urgent"] },
      },
    },
    link: {
      fields: {
        url: { type: "string" },
      },
    },
  },
};
