// Schema v2 = v1 + one new node type ("tag") + two optional fields.
import { schema as v1 } from "./schema.v1.js";

export const schema = {
  version: 2,
  nodeTypes: {
    ...v1.nodeTypes,
    section: {
      fields: {
        ...v1.nodeTypes.section.fields,
        owner: { type: "string", optional: true },
      },
    },
    item: {
      fields: {
        ...v1.nodeTypes.item.fields,
        dueDate: { type: "string", optional: true },
      },
    },
    tag: {
      fields: {
        name: { type: "string" },
      },
    },
  },
};
