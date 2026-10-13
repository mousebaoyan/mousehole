// Creates the first admin and prints a one-time login link: node scripts/bootstrap.ts --qq <QQ>
import { parseArgs } from "node:util";
import { z } from "zod";
import { issueLoginLink } from "../server/modules/auth/service.ts";
import { ensureAdmin } from "../server/modules/users/service.ts";
import { db } from "../server/platform/db.ts";
import { env } from "../server/platform/env.ts";

const { values } = parseArgs({ options: { qq: { type: "string" } } });
const qq = z.coerce.number().int().min(10000).parse(values.qq);

const token = await issueLoginLink(await ensureAdmin(qq));
console.log(`${env.PUBLIC_URL}/login/link?token=${token}`);
await db.destroy();
