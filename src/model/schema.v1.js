// Schema v1 — the base grammar.
export const schema = {
  version: 1,
  nodeTypes: {
    root: { fields: {} },
    section: {
      fields: {
        title: { type: "string" },
        status: { type: "enum", values: ["open", "closed"] },
      },
    },
    item: {
      fields: {
        label: { type: "string" },
        priority: { type: "enum", values: ["low", "med", "high"] },
      },
    },
    note: {
      fields: {
        text: { type: "string" },
      },
    },
  },
};
