// Made afresh before the server starts, which migrates it.
import { adminQuery } from "../test/database.ts";

await adminQuery("DROP DATABASE IF EXISTS mousehole_e2e WITH (FORCE)");
await adminQuery("CREATE DATABASE mousehole_e2e");
