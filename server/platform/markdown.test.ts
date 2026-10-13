import { describe, expect, test } from "vitest";
import { env } from "./env.ts";
import { renderMarkdown } from "./markdown.ts";

async function html(source: string) {
  return (await renderMarkdown(source)).html;
}

describe("Markdown 渲染", () => {
  test("原始 HTML 原样显示成文字", async () => {
    const out = await html('<script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(out).not.toMatch(/<script|<img/);
    expect(out).toContain("&lt;script&gt;");
  });

  test("javascript: 之类的链接不生成链接", async () => {
    for (const href of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "vbscript:x",
      "data:text/html,x",
    ]) {
      expect(await html(`[点我](${href})`)).not.toContain("<a");
    }
  });

  test("站外链接带 nofollow，站内的不带", async () => {
    expect(await html("[x](https://example.com/a)")).toContain('rel="ugc nofollow noopener"');
    expect(await html("[x](//example.com/a)")).toContain('rel="ugc nofollow noopener"');
    expect(await html(`[x](${env.PUBLIC_URL}/t/2) [y](/t/3)`)).not.toContain("rel=");
  });

  test("只显示上传的图片，别处的图片变成链接", async () => {
    expect(await html("![图](/uploads/ab/abc-960.webp)")).toContain('<img src="/uploads/');
    const out = await html("![图](https://example.com/a.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain('<a href="https://example.com/a.png"');
  });

  test("提及：链接到 /u/ID、文字以 @ 开头的才算，去重", async () => {
    const { html: out, mentions } = await renderMarkdown(
      "[@鼠鼠](/u/7) [@鼠鼠](/u/7) [@阿柒](/u/8) [主页](/u/9)",
    );
    expect(mentions).toEqual([7, 8]);
    expect(out).toContain('<a href="/u/7" class="mention">@鼠鼠</a>');
    expect(out).toContain('<a href="/u/9">主页</a>');
  });

  test("任务列表", async () => {
    const out = await html("- [ ] 报名\n- [x] 简历\n- 普通");
    expect(out).toContain('<li class="task"><input type="checkbox" disabled> 报名</li>');
    expect(out).toContain('<input type="checkbox" disabled checked> 简历');
    expect(out).toContain("<li>普通</li>");
  });

  test("代码按语言高亮，认不出的语言照原样转义", async () => {
    expect(await html("```cpp\nint main() {}\n```")).toContain(
      '<span class="hljs-type">int</span>',
    );
    const plain = await html("```whatever\n<b>x</b>\n```");
    expect(plain).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("单个换行就是换行", async () => {
    expect(await html("第一行\n第二行")).toBe("<p>第一行<br>\n第二行</p>\n");
  });
});
