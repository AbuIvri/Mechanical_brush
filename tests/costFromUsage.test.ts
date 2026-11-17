import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { costFromUsage } from "../electron/providers/umage2/Umage2Mapper";

describe("OpenAI cost comes from the tokens it reports", () => {
  it("prices text in, image in and image out at their own rates", () => {
    // 2.5: $5 text, $8 image in, $30 out, per 1M tokens.
    const usd = costFromUsage("gpt-image-2.5-sunburst", {
      input_tokens: 1200,
      output_tokens: 7000,
      input_tokens_details: { text_tokens: 200, image_tokens: 1000 },
    });
    expect(usd).toBeCloseTo((200 * 5 + 1000 * 8 + 7000 * 30) / 1e6, 4);
  });

  it("counts the input images, which the size table never did", () => {
    const outOnly = costFromUsage("gpt-image-2.5-flare", { input_tokens: 0, output_tokens: 6000, input_tokens_details: { text_tokens: 0, image_tokens: 0 } })!;
    const withCrop = costFromUsage("gpt-image-2.5-flare", { input_tokens: 4000, output_tokens: 6000, input_tokens_details: { text_tokens: 0, image_tokens: 4000 } })!;
    expect(withCrop - outOnly).toBeCloseTo((4000 * 8) / 1e6, 4);
  });

  it("bills cached tokens at the cached rate", () => {
    const usd = costFromUsage("gpt-image-2", {
      input_tokens: 1000,
      output_tokens: 1000,
      input_tokens_details: { text_tokens: 0, image_tokens: 1000, cached_tokens: 400 },
    });
    expect(usd).toBeCloseTo((600 * 8 + 400 * 2 + 1000 * 30) / 1e6, 4);
  });

  it("without a breakdown, prices all input at the image rate", () => {
    expect(costFromUsage("gpt-image-2", { input_tokens: 1000, output_tokens: 0 + 1000 })).toBeCloseTo((1000 * 8 + 1000 * 30) / 1e6, 4);
  });

  it("returns null when there is nothing to price from, so the estimate is used", () => {
    expect(costFromUsage("gpt-image-2", undefined)).toBeNull();
    expect(costFromUsage("gpt-image-2", { input_tokens: 10, output_tokens: 0 })).toBeNull();
    expect(costFromUsage("some-future-model", { input_tokens: 10, output_tokens: 10 })).toBeNull();
  });

  it("both OpenAI calls pass the response usage through", () => {
    const src = readFileSync("electron/providers/umage2/Umage2Provider.ts", "utf8");
    expect(src.match(/priced\(model, \(resp as any\)\.usage/g)).toHaveLength(2);
  });
});
