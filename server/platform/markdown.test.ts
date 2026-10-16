import { describe, expect, test } from "vitest";
import { env } from "./env.ts";
import { excerpt, renderMarkdown, type ShownImage } from "./markdown.ts";

// Stands in for the uploads: only /uploads/ addresses are known images.
async function images(srcs: string[]) {
  return new Map<string, ShownImage>(
    srcs
      .filter((s) => s.startsWith("/uploads/"))
      .map((s) => [s, { src: s.replace(".webp", "-960.webp"), href: s, width: 960, height: 540 }]),
  );
}

function render(source: string) {
  return renderMarkdown(source, images);
}

async function html(source: string) {
  return (await render(source)).html;
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

  test("只显示上传的图片，写明大小，点开是大图；别处的图片变成链接", async () => {
    const { html: shown, images: used } = await render('![图"](/uploads/ab/abc.webp)');
    expect(shown).toContain(
      '<a href="/uploads/ab/abc.webp"><img src="/uploads/ab/abc-960.webp" alt="图&quot;" width="960" height="540" loading="lazy"></a>',
    );
    expect(used).toEqual(["/uploads/ab/abc.webp"]);
    const out = await html("![图](https://example.com/a.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain('<a href="https://example.com/a.png"');
  });

  test("提及：链接到 /u/ID、文字以 @ 开头的才算，去重", async () => {
    const { html: out, mentions } = await render(
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

  test("提示块：类型不分大小写，可以写标题，标题里能用 Markdown", async () => {
    expect(await html("> [!tip]\n> 早点联系导师")).toBe(
      '<div class="callout callout-tip">\n<p class="callout-title">提示</p>\n<p>早点联系导师</p>\n</div>\n',
    );
    expect(await html("> [!WARNING] **六月**截止\n>\n> 别拖")).toBe(
      '<div class="callout callout-warning">\n<p class="callout-title"><strong>六月</strong>截止</p>\n<p>别拖</p>\n</div>\n',
    );
    // Not a type it knows: an ordinary quote.
    expect(await html("> [!TODO] x")).toBe("<blockquote>\n<p>[!TODO] x</p>\n</blockquote>\n");
  });

  test("折叠：- 收起、+ 展开，FOLD 默认收起；里面能再套", async () => {
    expect(await html("> [!NOTE]- 面经\n> 一面")).toBe(
      '<details class="callout callout-note">\n<summary>面经</summary>\n<p>一面</p>\n</details>\n',
    );
    expect(await html("> [!caution]+\n> 小心")).toContain(
      '<details class="callout callout-caution" open>\n<summary>警告</summary>',
    );
    const nested = await html("> [!FOLD]\n> 外层\n> > [!TIP]\n> > 里层");
    expect(nested).toMatch(/^<details class="callout callout-fold">\n<summary>详情<\/summary>/);
    expect(nested).toContain('<div class="callout callout-tip">');
    expect(nested).toMatch(/<\/div>\n<\/details>\n$/);
  });

  test("剧透和高亮，剧透里能用别的格式", async () => {
    expect(await html("答案是||**B**||，==别外传==")).toBe(
      '<p>答案是<span class="spoiler" tabindex="0"><strong>B</strong></span>，<mark>别外传</mark></p>\n',
    );
    expect(await html("a || b")).toBe("<p>a || b</p>\n");
  });

  test("公式：行内和独立的都写成 MathML，价格不算公式，写错的照原样显示", async () => {
    const inline = await html("设 $x^2$ 为");
    expect(inline).toContain("<math><semantics><msup><mi>x</mi>");
    expect(inline).toContain('<annotation encoding="application/x-tex">x^2</annotation>');
    const block = await html("$$\n\\frac{a}{b}\n$$");
    expect(block).toMatch(/^<div class="math"><math display="block" class="tml-display"/);
    expect(block).toContain("<mfrac>");
    expect(await html("$$a+b$$")).toContain("<mi>a</mi><mo>+</mo><mi>b</mi>");
    expect(await html("花了 $5，赚了 $10")).toBe("<p>花了 $5，赚了 $10</p>\n");
    expect(await html("$5 和 $6")).toBe("<p>$5 和 $6</p>\n");
    expect(await html("错的 $\\frac{a$ 公式")).toBe("<p>错的 $\\frac{a$ 公式</p>\n");
  });

  test("脚注：编号链到文末，同一页的几层楼不会重号", async () => {
    const one = await html("出自简章[^1]\n\n[^1]: 2026 年版");
    const id = /id="fnref-(\w+)-1"/.exec(one)?.[1];
    expect(one).toContain(
      `<sup class="footnote-ref"><a href="#fn-${id}-1" id="fnref-${id}-1">[1]</a></sup>`,
    );
    expect(one).toContain(
      `<section class="footnotes">\n<ol>\n<li id="fn-${id}-1" class="footnote-item">`,
    );
    expect(await html("出自简章[^1]\n\n[^1]: 2026 年版")).not.toContain(`fn-${id}-1`);
  });
});

describe("摘要", () => {
  test("去掉标签、还原转义、合并空白，按看到的字截断", async () => {
    const out = await html("**rank** 30% <能冲吗>\n\n- 夏令营\n- 预推免 👨‍👩‍👧 还有");
    expect(excerpt(out, 100)).toBe("rank 30% <能冲吗> 夏令营 预推免 👨‍👩‍👧 还有");
    expect(excerpt(out, 24)).toBe("rank 30% <能冲吗> 夏令营 预推免 👨‍👩‍👧…");
  });

  test("剧透不露出来，公式用 TeX，脚注的编号和返回箭头不要", async () => {
    const out = await html("> [!TIP] 结果\n> 去了||某校||，均分 $\\ge 90$[^1]\n\n[^1]: 百分制");
    expect(excerpt(out, 100)).toBe("结果 去了▇▇，均分 \\ge 90 百分制");
  });
});
