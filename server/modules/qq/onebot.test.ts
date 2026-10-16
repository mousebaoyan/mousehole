import { describe, expect, test } from "vitest";
import { escapeText, onebotToMarkdown, type Lookups, type Segment } from "./onebot.ts";

const lookups: Lookups = {
  members: async (qqs) =>
    new Map(
      qqs.filter((qq) => qq === 10001).map((qq) => [qq, { id: 7, display_name: "鼠鼠[26]" }]),
    ),
  image: async (url) => (url.includes("good") ? "/uploads/ab/abc.webp" : null),
  quoted: async (messageId) => (messageId === 5 ? 42 : null),
};

function convert(segments: Segment[]) {
  return onebotToMarkdown(segments, lookups);
}

describe("QQ 消息转 Markdown", () => {
  test("文字照原样显示：转义 Markdown 符号，链接保持可用，行首的列表、标题、引用不生效", () => {
    expect(escapeText("**不是粗体** <b>x</b> a_b `c`")).toBe(
      "\\*\\*不是粗体\\*\\* \\<b\\>x\\</b\\> a\\_b \\`c\\`",
    );
    expect(escapeText("||剧透|| ==高亮== $x$ a=b")).toBe(
      "\\|\\|剧透\\|\\| \\==高亮\\== \\$x\\$ a=b",
    );
    expect(escapeText("看 https://x.com/a_b*c 这个")).toBe("看 https://x.com/a_b*c 这个");
    expect(escapeText("# 标题\n> 引用\n- 列表\n1. 第一")).toBe(
      "\\# 标题\n\\> 引用\n\\- 列表\n1\\. 第一",
    );
  });

  test("@：论坛成员变成提及，别人只留名字，@全体忽略", async () => {
    const { markdown } = await convert([
      { type: "at", data: { qq: "10001" } },
      { type: "text", data: { text: " 和 " } },
      { type: "at", data: { qq: 20002, name: "路人" } },
      { type: "at", data: { qq: "all" } },
      { type: "text", data: { text: " 看看" } },
    ]);
    expect(markdown).toBe("[@鼠鼠\\[26\\]](/u/7) 和 @路人 看看");
  });

  test("图片转存成功显示图片，失败显示「图片已失效」；其他消息段变成占位文字", async () => {
    const { markdown } = await convert([
      { type: "image", data: { url: "https://gchat.qpic.cn/good" } },
      { type: "mface", data: { url: "https://gxh.vip.qq.com/bad", summary: "[吃瓜]" } },
      { type: "face", data: { id: "14" } },
      { type: "file", data: { name: "简历.pdf" } },
      { type: "video", data: {} },
      { type: "json", data: { data: "{}" } },
      { type: "poke", data: {} },
    ]);
    expect(markdown).toBe(
      "![](/uploads/ab/abc.webp)[图片已失效][表情][文件] 简历.pdf[视频][卡片][消息]",
    );
  });

  test("引用了转到论坛的消息就是回复那一层", async () => {
    expect(
      await convert([
        { type: "reply", data: { id: "5" } },
        { type: "text", data: { text: "同意" } },
      ]),
    ).toEqual({
      markdown: "同意",
      replyToId: 42,
    });
    expect((await convert([{ type: "reply", data: { id: "6" } }])).replyToId).toBeNull();
  });
});
