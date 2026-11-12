import type { ModuleImplementation } from "../../foundations/host.ts";

export const implementation: ModuleImplementation = {
  register(ctx) {
    ctx.contribute("queries.ask", {
      id: "names",
      payload: {
        label: "Name index",
        handle(input: unknown) {
          if (typeof input !== "string") throw new Error("The question was not a string.");
          const question = input.trim();
          if (!question) throw new Error("The question was empty.");
          return { question, letters: question.length };
        },
      },
    });
  },
};
