import { describe, expect, test } from "vitest";
import { anyQuery, documentTokens, phraseQuery, terms } from "./search-terms.ts";

describe("搜索分词", () => {
  test("汉字两两切分，英文和数字按词，统一小写，标点去掉", () => {
    expect(terms("保研夏令营 Rank 30%，华五")).toEqual([
      ["保研", "研夏", "夏令", "令营"],
      ["rank"],
      ["30"],
      ["华五"],
    ]);
    expect(documentTokens("中")).toBe("中");
  });

  test("汉字前后的数字和英文单独成词", () => {
    expect(terms("2026年夏令营CS")).toEqual([["2026"], ["年夏", "夏令", "令营"], ["cs"]]);
    expect(phraseQuery("夏令营")).toBe("'夏令' <-> '令营'");
  });

  test("查询：每个词是一个短语，词之间都要有；相似问题是任意一个", () => {
    expect(phraseQuery("华东师范 cv")).toBe("'华东' <-> '东师' <-> '师范' & 'cv'");
    expect(anyQuery("夏令营夏令")).toBe("'夏令' | '令营' | '营夏'");
  });

  test("引号和运算符进不了查询", () => {
    expect(phraseQuery("a'b | !c & (d)")).toBe("'a' & 'b' & 'c' & 'd'");
  });
});
