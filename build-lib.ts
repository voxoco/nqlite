import { Database } from "sqlite3";

const db = new Database(":memory:");

db.close();

Deno.exit(0);
