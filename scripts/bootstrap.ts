// Prints a one-time login link: --owner for the site owner, who sets the site up; --qq <QQ> for an
// admin with that QQ number, for trying things out locally.
import { parseArgs } from "node:util";
import { z } from "zod";
import { issueLoginLink } from "../server/modules/auth/service.ts";
import { ensureAdmin, ensureOwner } from "../server/modules/users/service.ts";
import { db } from "../server/platform/db.ts";
import { env } from "../server/platform/env.ts";

const { values } = parseArgs({ options: { owner: { type: "boolean" }, qq: { type: "string" } } });
if (values.owner === (values.qq !== undefined))
  throw new Error("用法：bootstrap --owner 或 bootstrap --qq <QQ号>");
const userId = values.owner
  ? await ensureOwner()
  : await ensureAdmin(z.coerce.number().int().min(10000).parse(values.qq));

const token = await issueLoginLink(userId);
console.log(`${env.PUBLIC_URL}/login/link?token=${token}`);
await db.destroy();
