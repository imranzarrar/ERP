import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

// See server.ts for why this isn't the default `.env` filename.
dotenv.config({ path: "app.secrets", quiet: true });

const sqlHost = process.env.SQL_HOST;
const sqlDbName = process.env.SQL_DB_NAME;
const user = process.env.SQL_USER;
const password = process.env.SQL_PASSWORD;

if (!sqlHost || !sqlDbName || !user || !password) {
  console.warn("Missing SQL credentials, checking standard Postgres vars if needed");
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  schemaFilter: ["public"],
  dbCredentials: {
    host: sqlHost as string,
    port: 5432,
    user: user as string,
    password: password as string,
    database: sqlDbName as string,
    ssl: false,
  },
  verbose: true,
});
