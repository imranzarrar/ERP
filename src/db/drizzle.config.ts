import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";
import { DB_PROVIDER, AIVEN_CONFIG } from "./dbCredentials";

dotenv.config();

const sqlHost = DB_PROVIDER === 'aiven' ? AIVEN_CONFIG.host : process.env.SQL_HOST;
const sqlDbName = DB_PROVIDER === 'aiven' ? AIVEN_CONFIG.database : process.env.SQL_DB_NAME;
const user = DB_PROVIDER === 'aiven' ? AIVEN_CONFIG.user : process.env.SQL_USER;
const password = DB_PROVIDER === 'aiven' ? AIVEN_CONFIG.password : process.env.SQL_PASSWORD;
const port = DB_PROVIDER === 'aiven' ? AIVEN_CONFIG.port : 5432;
const ssl = DB_PROVIDER === 'aiven' ? AIVEN_CONFIG.ssl : false;

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
    port: port as number,
    user: user as string,
    password: password as string,
    database: sqlDbName as string,
    ssl: ssl,
  },
  verbose: true,
});
