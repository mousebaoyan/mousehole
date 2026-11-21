import { globSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

// Rules of docs/development.md that the code can be checked against.

const sources = globSync("**/*.ts", { cwd: import.meta.dirname })
  .filter((file) => !file.endsWith(".test.ts"))
  .map((file) => ({
    file,
    text: readFileSync(`${import.meta.dirname}/${file}`, "utf8").replaceAll(/(^|\s)\/\/.*$/gm, ""),
  }));

// SQL is written with its keywords in capitals.
test("每张表只由一个模块写入", () => {
  const writers = new Map<string, Set<string>>();
  for (const { file, text } of sources) {
    const module = /^modules\/([^/]+)\//.exec(file)?.[1] ?? file.split("/")[0];
    const writes = text.matchAll(
      /(?:\.(?:insertInto|updateTable|deleteFrom)\(\s*"|\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+)([a-z_]+)/g,
    );
    for (const [, table] of writes) {
      writers.set(table, (writers.get(table) ?? new Set()).add(module));
    }
  }
  expect(writers.get("notifications")).toEqual(new Set(["notifications"]));
  const shared = [...writers].filter(([, modules]) => modules.size > 1);
  expect(shared).toEqual([]);
});

test("代码里的错误码都写进了 api.md", () => {
  const api = readFileSync(`${import.meta.dirname}/../docs/api.md`, "utf8");
  const codes = new Set(
    sources.flatMap(({ text }) =>
      [...text.matchAll(/(?:new AppError\(\s*\d+,\s*|error:\s*\{\s*code:\s*)"([a-z_]+)"/g)].map(
        ([, code]) => code,
      ),
    ),
  );
  expect(codes).toContain("thread_not_found");
  expect(codes).toContain("internal_error");
  expect([...codes].filter((code) => !new RegExp(`\\b${code}\\b`).test(api))).toEqual([]);
});
